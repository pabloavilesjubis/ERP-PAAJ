import type { MouseEvent, ReactNode } from 'react';
import { Icon } from '@/components/icons/Icon';
import { Button } from './Button';

interface Props {
  title: string;
  onClose: () => void;
  onSave?: () => void;
  saveLabel?: string;
  saveDisabled?: boolean;
  children: ReactNode;
}

export function Modal({ title, onClose, onSave, saveLabel = 'Guardar', saveDisabled, children }: Props) {
  function handleBackdrop(e: MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }
  return (
    <div className="modal-backdrop" onClick={handleBackdrop}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="btn-icon" onClick={onClose} aria-label="Cerrar">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {onSave && (
          <div className="modal-footer">
            <Button variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button onClick={onSave} disabled={saveDisabled} leading={<Icon name="check" size={15} />}>
              {saveLabel}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
