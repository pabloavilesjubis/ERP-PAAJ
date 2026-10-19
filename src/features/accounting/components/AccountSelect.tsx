import { useEffect, useMemo, useRef, useState } from 'react';
import type { Account } from '../types';
import { accountLabel } from '../hooks';

interface Props {
  accounts: Account[];
  value: number | null;
  onChange: (id: number | null) => void;
  /** Solo cuentas de movimiento activas (lo normal para registrar). */
  movementOnly?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}

/** Combobox de cuentas: escribe código o nombre, Enter elige la primera coincidencia. */
export function AccountSelect({ accounts, value, onChange, movementOnly = true, placeholder = 'Buscar cuenta…', autoFocus, disabled }: Props) {
  const selected = accounts.find(a => a.id === value) ?? null;
  const [text, setText] = useState(selected ? accountLabel(selected) : '');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setText(selected ? accountLabel(selected) : ''); }, [selected?.id]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const options = useMemo(() => {
    const pool = movementOnly ? accounts.filter(a => a.allows_movements && a.is_active) : accounts;
    const t = text.trim().toLowerCase();
    if (!t || (selected && text === accountLabel(selected))) return pool.slice(0, 60);
    return pool.filter(a => a.code.startsWith(t) || a.name.toLowerCase().includes(t)).slice(0, 60);
  }, [accounts, movementOnly, text, selected]);

  function pick(a: Account | undefined) {
    if (!a) return;
    onChange(a.id);
    setText(accountLabel(a));
    setOpen(false);
  }

  return (
    <div ref={ref} className="combo">
      <input
        className="field-input"
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        onFocus={e => { setOpen(true); e.currentTarget.select(); }}
        onChange={e => { setText(e.target.value); setOpen(true); setHi(0); if (!e.target.value) onChange(null); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, options.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(options[hi]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
        onBlur={() => { if (!text.trim()) onChange(null); else if (selected) setText(accountLabel(selected)); }}
      />
      {open && !disabled && (
        <div className="combo-list">
          {options.length === 0 && <div className="combo-empty">Sin coincidencias</div>}
          {options.map((a, i) => (
            <div key={a.id}
              className={`combo-item${i === hi ? ' hi' : ''}${a.allows_movements ? '' : ' major'}`}
              onMouseDown={e => { e.preventDefault(); pick(a); }}
              onMouseEnter={() => setHi(i)}>
              <span className="combo-code">{a.code}</span> {a.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
