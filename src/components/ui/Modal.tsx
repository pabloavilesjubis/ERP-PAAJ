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
  /** Ancho: md (560px, por defecto), wide (1100px), xwide (1280px). */
  size?: 'md' | 'wide' | 'xwide';
  /** Pie personalizado (reemplaza Cancelar/Guardar). */
  footer?: ReactNode;
}

export function Modal({ title, onClose, onSave, saveLabel = 'Guardar', saveDisabled, children, size = 'md', footer }: Props) {
  function handleBackdrop(e: MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }
  return (
    <div className="modal-backdrop" onClick={handleBackdrop}>
      <div className={`modal${size === 'md' ? '' : ` ${size}`}`} role="dialog" aria-label={title}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="btn-icon" onClick={onClose} aria-label="Cerrar">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
        {!footer && onSave && (
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
