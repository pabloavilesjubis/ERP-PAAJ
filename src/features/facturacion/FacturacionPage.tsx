import { useState } from 'react';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { PosTab } from './PosTab';
import { ProductosTab } from './ProductosTab';

type Tab = 'pos' | 'productos';

export function FacturacionPage() {
  const [tab, setTab] = useState<Tab>('pos');

  return (
    <div>
      <SectionHeader
        title="Facturación"
        description="Punto de venta + emisión de DTE (FCF / CCF / FSE) contra Hacienda"
      />

      <div className="tabs">
        <div
          className={`tab${tab === 'pos' ? ' active' : ''}`}
          onClick={() => setTab('pos')}
        >
          Punto de venta
        </div>
        <div
          className={`tab${tab === 'productos' ? ' active' : ''}`}
          onClick={() => setTab('productos')}
        >
          Productos / Servicios
        </div>
      </div>

      {tab === 'pos' && <PosTab />}
      {tab === 'productos' && <ProductosTab />}
    </div>
  );
}
