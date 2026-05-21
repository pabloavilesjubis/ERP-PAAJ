import { STORAGE_KEY } from '@/config/constants';
import type { AppData } from '@/types/domain';
import type { DataAdapter } from './adapter';
import { seedData } from './seed';

const emptyCollections: AppData = {
  ventasConsumidor: [],
  ventasContribuyente: [],
  compras: [],
  contribuyentes: [],
  productos: [],
  reportesGenerados: [],
};

export class LocalAdapter implements DataAdapter {
  readonly kind = 'local' as const;

  async load(): Promise<AppData> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const seeded = seedData();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
        return seeded;
      }
      // Merge defensivo — si el snapshot guardado es de una versión anterior
      // que no incluía alguna colección (ej. `productos`), no rompemos.
      const parsed = JSON.parse(raw) as Partial<AppData>;
      return { ...emptyCollections, ...parsed };
    } catch {
      return seedData();
    }
  }

  async save(data: AppData): Promise<void> {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }
}
