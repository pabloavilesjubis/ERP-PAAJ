import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PeriodMode = 'monthly' | 'annual';

interface PeriodState {
  mode: PeriodMode;
  month: number;
  year: number;
  setMode: (m: PeriodMode) => void;
  setMonth: (m: number) => void;
  setYear: (y: number) => void;
  setPeriod: (m: number, y: number) => void;
}

const now = new Date();

export const usePeriodStore = create<PeriodState>()(
  persist(
    set => ({
      mode: 'monthly',
      month: now.getMonth(),
      year: now.getFullYear(),
      setMode: m => set({ mode: m }),
      setMonth: m => set({ month: m }),
      setYear: y => set({ year: y }),
      setPeriod: (month, year) => set({ month, year }),
    }),
    { name: 'abx-erp-period' },
  ),
);
