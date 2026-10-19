import { Input } from '@/components/ui/Field';
import { currentMonth, previousMonth, yearRange } from '../dates';

export interface Range { from: string; to: string }

/** Desde / hasta con atajos (este mes, mes anterior, este año). */
export function DateRange({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const y = new Date().getFullYear();
  const presets: Array<[string, Range]> = [
    ['Este mes', currentMonth()],
    ['Mes anterior', previousMonth()],
    [`Año ${y}`, yearRange(y)],
    [`Año ${y - 1}`, yearRange(y - 1)],
  ];
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <Input type="date" value={value.from} onChange={e => onChange({ ...value, from: e.target.value })} style={{ width: 150 }} />
      <span style={{ color: 'var(--fg-3)' }}>a</span>
      <Input type="date" value={value.to} onChange={e => onChange({ ...value, to: e.target.value })} style={{ width: 150 }} />
      {presets.map(([label, r]) => (
        <button key={label} type="button" className="btn btn-secondary btn-sm"
          style={value.from === r.from && value.to === r.to ? { borderColor: 'var(--brand-primary-600)', color: 'var(--brand-primary-700)' } : undefined}
          onClick={() => onChange(r)}>{label}</button>
      ))}
    </div>
  );
}
