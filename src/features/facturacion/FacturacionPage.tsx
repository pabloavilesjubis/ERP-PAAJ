import { useState } from 'react';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { PosTab, type NcContext } from './PosTab';
import { ProductosTab } from './ProductosTab';
import { DtesEmitidosTab, type DteEmitido } from './DtesEmitidosTab';
import { CorrelativosTab } from './CorrelativosTab';

type Tab = 'pos' | 'emitidos' | 'productos' | 'correlativos';

export function FacturacionPage() {
  const [tab, setTab] = useState<Tab>('pos');
  const [ncContext, setNcContext] = useState<NcContext | null>(null);

  function handleCrearNc(ccf: DteEmitido) {
    setNcContext({
      ref: { ccfCodigo: ccf.codigoGeneracion, ccfFecha: ccf.fecha },
      clienteNit: ccf.nit,
      clienteNombre: ccf.cliente,
      onCompleted: () => setNcContext(null),
    });
    setTab('pos');
  }

  return (
    <div>
      <SectionHeader
        title="Facturación"
        description="Punto de venta + emisión de DTE (FCF / CCF / NC / FSE) contra Hacienda"
      />

      <div className="tabs">
        <div className={`tab${tab === 'pos' ? ' active' : ''}`} onClick={() => setTab('pos')}>
          Punto de venta
          {ncContext && <span style={{
            marginLeft: 6, padding: '1px 6px', borderRadius: 'var(--r-pill)',
            background: 'var(--brand-accent-700)', color: '#fff', fontSize: 10,
          }}>NC</span>}
        </div>
        <div className={`tab${tab === 'emitidos' ? ' active' : ''}`} onClick={() => setTab('emitidos')}>
          DTEs Emitidos
        </div>
        <div className={`tab${tab === 'productos' ? ' active' : ''}`} onClick={() => setTab('productos')}>
          Productos / Servicios
        </div>
        <div className={`tab${tab === 'correlativos' ? ' active' : ''}`} onClick={() => setTab('correlativos')}>
          Correlativos
        </div>
      </div>

      {tab === 'pos' && <PosTab ncContext={ncContext ?? undefined} />}
      {tab === 'emitidos' && <DtesEmitidosTab onCrearNc={handleCrearNc} />}
      {tab === 'productos' && <ProductosTab />}
      {tab === 'correlativos' && <CorrelativosTab />}
    </div>
  );
}
