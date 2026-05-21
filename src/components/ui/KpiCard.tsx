import type { CSSProperties, ReactNode } from 'react';
import clsx from 'clsx';

type Tone = 'default' | 'primary' | 'danger' | 'success' | 'warning';

interface Props {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  size?: 'lg' | 'md';
  style?: CSSProperties;
}

export function KpiCard({ label, value, hint, tone = 'default', size = 'lg', style }: Props) {
  return (
    <div className="kpi-card" style={style}>
      <div className="kpi-label">{label}</div>
      <div
        className={clsx('kpi-value', tone !== 'default' && tone)}
        style={size === 'md' ? { fontSize: 'var(--text-2xl)' } : undefined}
      >
        {value}
      </div>
      {hint && <div className="kpi-sub">{hint}</div>}
    </div>
  );
}
