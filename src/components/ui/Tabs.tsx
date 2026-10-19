import { NavLink } from 'react-router-dom';

interface TabLink { to: string; label: string; end?: boolean }

/** Pestañas como rutas (cada pestaña es una URL, se puede compartir/recargar). */
export function RouteTabs({ tabs }: { tabs: TabLink[] }) {
  return (
    <div className="tabs">
      {tabs.map(t => (
        <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}

/** Pestañas locales (estado del componente). */
export function Tabs<T extends string>({ value, onChange, tabs }: {
  value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="tabs">
      {tabs.map(t => (
        <button key={t.value} type="button" onClick={() => onChange(t.value)}
          className={`tab${value === t.value ? ' active' : ''}`}
          style={{ background: 'none', border: 'none', fontFamily: 'inherit' }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
