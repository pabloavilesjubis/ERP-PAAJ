import { useRef, useState } from 'react';
import { Icon } from '@/components/icons/Icon';
import { Button } from '@/components/ui/Button';
import { SectionHeader } from '@/components/ui/SectionHeader';
import {
  csvTemplates, exportCsv, exportSampleCsv, parseCsv, type CsvTemplate, type CsvTemplateKey,
} from '@/lib/utils/csv';
import { inPeriod } from '@/lib/utils/format';
import { useDataStore } from '@/stores/data.store';
import { usePeriodStore } from '@/stores/period.store';
import type { AppCollection, AppData } from '@/types/domain';

const KEY_TO_COLLECTION: Record<CsvTemplateKey, AppCollection> = {
  ventas_consumidor: 'ventasConsumidor',
  ventas_contribuyente: 'ventasContribuyente',
  compras: 'compras',
  contribuyentes: 'contribuyentes',
};

interface ImportLog {
  templateKey: CsvTemplateKey;
  ok: number;
  errors: { row: number; reason: string }[];
}

export function CsvPage() {
  const data = useDataStore(s => s.data);
  const patch = useDataStore(s => s.patch);
  const { month, year } = usePeriodStore();
  const [importing, setImporting] = useState<CsvTemplateKey | null>(null);
  const [lastImport, setLastImport] = useState<ImportLog | null>(null);
  const fileRefs = useRef<Record<CsvTemplateKey, HTMLInputElement | null>>({
    ventas_consumidor: null, ventas_contribuyente: null, compras: null, contribuyentes: null,
  });

  function listForExport(key: CsvTemplateKey): unknown[] {
    const collection = KEY_TO_COLLECTION[key];
    const list = data[collection] as unknown[];
    if (key === 'contribuyentes') return list;
    return (list as { fecha: string }[]).filter(r => inPeriod(r.fecha, month, year));
  }

  function handleExport(key: CsvTemplateKey) {
    const template = csvTemplates[key] as CsvTemplate<unknown>;
    exportCsv(template, listForExport(key), { month, year });
  }

  function handleSample(key: CsvTemplateKey) {
    exportSampleCsv(csvTemplates[key] as CsvTemplate<unknown>);
  }

  async function handleFile(key: CsvTemplateKey, file: File) {
    setImporting(key);
    try {
      const template = csvTemplates[key] as CsvTemplate<unknown>;
      const result = await parseCsv(file, template);
      if (result.ok.length) {
        const collection = KEY_TO_COLLECTION[key];
        await patch((prev): AppData => {
          const merged = [...(prev[collection] as unknown[]), ...result.ok];
          return { ...prev, [collection]: merged } as AppData;
        });
      }
      setLastImport({ templateKey: key, ok: result.ok.length, errors: result.errors });
    } finally {
      setImporting(null);
    }
  }

  return (
    <div>
      <SectionHeader
        title="Importar / Exportar CSV"
        description="Genera archivos a partir de los modelos o importa datos desde planillas existentes."
      />

      <div className="banner banner-info" style={{ marginBottom: 'var(--s-5)' }}>
        <Icon name="alert" size={16} />
        Las exportaciones de movimientos respetan el período seleccionado en el menú superior. El catálogo de contribuyentes se exporta completo.
      </div>

      <div style={{ display: 'grid', gap: 'var(--s-5)' }}>
        {(Object.keys(csvTemplates) as CsvTemplateKey[]).map(key => {
          const t = csvTemplates[key];
          const count = listForExport(key).length;

          return (
            <div className="kpi-card" key={key} style={{ padding: 'var(--s-6)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-4)', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 320px' }}>
                  <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, marginBottom: 4 }}>{t.label}</div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-3)' }}>{t.description}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-4)', marginTop: 8, fontFamily: 'var(--font-mono)' }}>
                    Columnas: {t.headers.join(', ')}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginTop: 8 }}>
                    {count} registro{count === 1 ? '' : 's'} disponibles{key === 'contribuyentes' ? '' : ' en el período'}.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <Button variant="secondary" size="sm" onClick={() => handleSample(key)} leading={<Icon name="download" size={14} />}>
                    Modelo (vacío)
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => handleExport(key)} leading={<Icon name="download" size={14} />} disabled={count === 0}>
                    Exportar
                  </Button>
                  <input
                    ref={el => { fileRefs.current[key] = el; }}
                    type="file" accept=".csv,text/csv" hidden
                    onChange={async e => {
                      const f = e.target.files?.[0];
                      if (f) await handleFile(key, f);
                      e.target.value = '';
                    }}
                  />
                  <Button size="sm" onClick={() => fileRefs.current[key]?.click()} disabled={importing === key}
                    leading={<Icon name="upload" size={14} />}>
                    {importing === key ? 'Importando…' : 'Importar'}
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {lastImport && (
        <div className={`banner ${lastImport.errors.length ? 'banner-warning' : 'banner-success'}`} style={{ marginTop: 'var(--s-5)' }}>
          <Icon name={lastImport.errors.length ? 'alert' : 'check'} size={16} />
          <div>
            Importación de <strong>{csvTemplates[lastImport.templateKey].label}</strong>: {lastImport.ok} fila(s) cargadas.
            {lastImport.errors.length > 0 && (
              <div style={{ marginTop: 4, fontSize: 'var(--text-xs)' }}>
                {lastImport.errors.length} fila(s) con error: {lastImport.errors.slice(0, 5).map(e => `#${e.row} (${e.reason})`).join(' · ')}
                {lastImport.errors.length > 5 && '…'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
