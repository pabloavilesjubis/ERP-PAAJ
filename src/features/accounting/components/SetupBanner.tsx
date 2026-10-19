import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { accApi } from '../api';
import { accKeys } from '../hooks';

/** Guía a una empresa nueva: primero el catálogo, luego asignar las cuentas por función. */
export function SetupBanner() {
  const q = useQuery({ queryKey: accKeys.setup, queryFn: accApi.setup, staleTime: 60_000 });
  if (!q.data) return null;
  if (q.data.accounts === 0) {
    return <div className="banner banner-warning" style={{ marginBottom: 'var(--s-4)' }}>
      Paso 1: carga el catálogo de cuentas de la empresa en <Link to="/contabilidad/catalogo">Catálogo de cuentas</Link>.
    </div>;
  }
  if (q.data.missing_roles.length > 0) {
    const names = q.data.missing_roles.slice(0, 4).map(r => r.label).join(', ');
    return <div className="banner banner-warning" style={{ marginBottom: 'var(--s-4)' }}>
      Paso 2: asigna las cuentas por función en <Link to="/contabilidad/configuracion">Configuración contable</Link> —
      faltan {q.data.missing_roles.length} ({names}{q.data.missing_roles.length > 4 ? '…' : ''}). Sin ellas no se contabilizan automáticamente ventas, compras ni bancos.
    </div>;
  }
  return null;
}
