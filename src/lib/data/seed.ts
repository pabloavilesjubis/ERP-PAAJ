import type { AppData } from '@/types/domain';
import { newId } from '@/lib/utils/format';

export function seedData(): AppData {
  return {
    ventasConsumidor: [
      { id: newId(), fecha: '2026-04-03', descripcion: 'Venta mostrador — materiales varios', monto: '1250.00', notas: '' },
      { id: newId(), fecha: '2026-04-08', descripcion: 'Servicio instalación eléctrica', monto: '380.00', notas: '' },
      { id: newId(), fecha: '2026-04-15', descripcion: 'Repuestos y accesorios', monto: '620.50', notas: '' },
    ],
    ventasContribuyente: [
      { id: newId(), fecha: '2026-04-05', cliente: 'Constructora ABC S.A. de C.V.', nrc: '123456-7', descripcion: 'Suministro de materiales construcción', gravado: '5800.00', exento: '0.00', notas: '' },
      { id: newId(), fecha: '2026-04-12', cliente: 'Ferretería del Norte', nrc: '234567-8', descripcion: 'Herramientas y equipos', gravado: '2100.00', exento: '0.00', notas: '' },
    ],
    compras: [
      { id: newId(), fecha: '2026-04-02', proveedor: 'Distribuidora Industrial S.A.', nrc: '987654-3', descripcion: 'Inventario general Q1', monto: '3200.00', ivaCredito: '416.00', notas: '' },
      { id: newId(), fecha: '2026-04-10', proveedor: 'Servicios Contables Ltda.', nrc: '876543-2', descripcion: 'Honorarios contabilidad abril', monto: '450.00', ivaCredito: '58.50', notas: '' },
      { id: newId(), fecha: '2026-04-18', proveedor: 'Suministros de Oficina Express', nrc: '765432-1', descripcion: 'Material de oficina', monto: '185.00', ivaCredito: '24.05', notas: '' },
    ],
    contribuyentes: [
      { id: newId(), nombre: 'Constructora ABC S.A. de C.V.', nit: '0614-010190-001-2', nrc: '123456-7', giro: 'Construcción', telefono: '2234-5678', email: 'contabilidad@constructoraabc.com', direccion: 'Col. Escalón, San Salvador', tipo: 'Cliente' },
      { id: newId(), nombre: 'Ferretería del Norte', nit: '0614-110180-002-3', nrc: '234567-8', giro: 'Ferretería', telefono: '2345-6789', email: 'facturacion@ferreterianorte.com', direccion: 'Av. Norte 45, Santa Ana', tipo: 'Cliente' },
      { id: newId(), nombre: 'Distribuidora Industrial S.A.', nit: '0614-220170-003-4', nrc: '987654-3', giro: 'Distribución industrial', telefono: '2456-7890', email: 'ventas@distindustrial.com', direccion: 'Zona Industrial, Soyapango', tipo: 'Proveedor' },
    ],
    productos: [
      { id: newId(), codigo: 'SRV-001', nombre: 'Consultoría por hora', descripcion: 'Hora de consultoría profesional', tipo: 'servicio', precioUnitario: '50.00', uniMedida: 59, activo: true },
      { id: newId(), codigo: 'SRV-002', nombre: 'Instalación eléctrica', descripcion: 'Servicio de instalación con materiales incluidos', tipo: 'servicio', precioUnitario: '380.00', uniMedida: 59, activo: true },
      { id: newId(), codigo: 'BIE-001', nombre: 'Caja de tornillos 1/2"', descripcion: 'Caja x 100 unidades', tipo: 'bien', precioUnitario: '12.50', uniMedida: 59, activo: true },
    ],
    correlativosDte: [],
    reportesGenerados: [],
  };
}
