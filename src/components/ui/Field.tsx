import type { InputHTMLAttributes, SelectHTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

interface FieldProps {
  label: string;
  error?: string;
  children: ReactNode;
  fullWidth?: boolean;
}

export function Field({ label, error, children, fullWidth }: FieldProps) {
  return (
    <div className="field-group" style={fullWidth ? { gridColumn: '1/-1' } : undefined}>
      <label className="field-label">{label}</label>
      {children}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement>;
export function Input({ className, ...rest }: InputProps) {
  return <input className={clsx('field-input', className)} {...rest} />;
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;
export function Select({ className, ...rest }: SelectProps) {
  return <select className={clsx('field-input', className)} {...rest} />;
}
