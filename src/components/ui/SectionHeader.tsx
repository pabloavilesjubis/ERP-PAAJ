import type { ReactNode } from 'react';

interface Props {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function SectionHeader({ title, description, actions }: Props) {
  return (
    <div className="section-header">
      <div>
        <div className="section-title">{title}</div>
        {description && <div className="section-desc">{description}</div>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 'var(--s-3)' }}>{actions}</div>}
    </div>
  );
}
