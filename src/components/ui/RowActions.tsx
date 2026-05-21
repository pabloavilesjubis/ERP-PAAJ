import { Icon } from '@/components/icons/Icon';

interface Props {
  onEdit: () => void;
  onDelete: () => void;
}

export function RowActions({ onEdit, onDelete }: Props) {
  return (
    <div style={{ display: 'flex', gap: 'var(--s-1)', justifyContent: 'flex-end' }}>
      <button className="btn-icon" onClick={onEdit} aria-label="Editar"><Icon name="edit" size={14} /></button>
      <button className="btn-icon" style={{ color: 'var(--danger-text)' }} onClick={onDelete} aria-label="Eliminar">
        <Icon name="trash" size={14} />
      </button>
    </div>
  );
}
