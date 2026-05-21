import { findActividad } from '@/lib/catalogos/mh';
import type { Contribuyente, Producto } from '@/types/domain';
import type { DteTipo } from './client';

/**
 * Helpers para convertir el carrito del POS al shape que espera el dte-service
 * (que a su vez los pasa a sus builders y a AJV). Este archivo NO valida —
 * AJV en el dte-service es la fuente de verdad. Aquí sólo armamos defaults
 * razonables para campos requeridos.
 */

export interface CartLine {
  producto: Producto;
  cantidad: number;
  /** Precio unitario al momento de agregarse (puede haber sido editado). */
  precioUnitario: number;
}

const IVA_RATE = 0.13;

/** Cálculo de totales del carrito. */
export function calcCartTotals(lines: CartLine[], tipo: DteTipo): {
  subtotal: number;       // suma de precio × cantidad (en la convención del tipo)
  iva: number;            // IVA aplicable (implícito en FCF, agregado en CCF/NC)
  total: number;          // monto a pagar
} {
  const subtotalLineas = lines.reduce(
    (s, l) => s + round2(l.precioUnitario * l.cantidad),
    0,
  );
  if (tipo === 'fcf') {
    // FCF: precios CON IVA — el IVA es implícito.
    const iva = round2((subtotalLineas * IVA_RATE) / (1 + IVA_RATE));
    return { subtotal: subtotalLineas, iva, total: subtotalLineas };
  }
  if (tipo === 'fse') {
    return { subtotal: subtotalLineas, iva: 0, total: subtotalLineas };
  }
  // CCF / NC: precios SIN IVA — se suma 13% al final.
  const iva = round2(subtotalLineas * IVA_RATE);
  return { subtotal: subtotalLineas, iva, total: round2(subtotalLineas + iva) };
}

/* ─────────────────────── Builders por tipo de DTE ─────────────────────── */

export function buildFcfData(args: {
  consecutivo: number;
  lines: CartLine[];
  receptor?: Contribuyente | null;
}): Record<string, unknown> {
  const items = args.lines.map(l => {
    const precioConIva = round2(l.precioUnitario);
    const ventaGravada = round2(precioConIva * l.cantidad);
    return {
      tipoItem: l.producto.tipo === 'servicio' ? 2 : 1,
      cantidad: l.cantidad,
      codigo: l.producto.codigo ?? null,
      codTributo: null,
      numeroDocumento: null,
      uniMedida: l.producto.uniMedida,
      descripcion: l.producto.nombre,
      precioUni: precioConIva,
      montoDescu: 0,
      ventaNoSuj: 0,
      ventaExenta: 0,
      ventaGravada,
      tributos: null,
      psv: 0,
      noGravado: 0,
    };
  });
  return {
    consecutivo: args.consecutivo,
    items,
    receptor: args.receptor ? receptorFcfFromContribuyente(args.receptor) : null,
  };
}

export function buildCcfData(args: {
  consecutivo: number;
  lines: CartLine[];
  receptor: Contribuyente;
}): Record<string, unknown> {
  const items = args.lines.map(l => {
    const precioSinIva = round2(l.precioUnitario);
    const ventaGravada = round2(precioSinIva * l.cantidad);
    return {
      tipoItem: l.producto.tipo === 'servicio' ? 2 : 1,
      cantidad: l.cantidad,
      codigo: l.producto.codigo ?? null,
      codTributo: null,
      numeroDocumento: null,
      uniMedida: l.producto.uniMedida,
      descripcion: l.producto.nombre,
      precioUni: precioSinIva,
      montoDescu: 0,
      ventaNoSuj: 0,
      ventaExenta: 0,
      ventaGravada,
      tributos: ['20'],          // IVA 13%
      psv: 0,
      noGravado: 0,
    };
  });
  return {
    consecutivo: args.consecutivo,
    items,
    receptor: receptorCcfFromContribuyente(args.receptor),
  };
}

export function buildFseData(args: {
  consecutivo: number;
  lines: CartLine[];
  sujetoExcluido: Contribuyente;
  reteRenta?: number;
}): Record<string, unknown> {
  const items = args.lines.map(l => {
    const precio = round2(l.precioUnitario);
    return {
      tipoItem: l.producto.tipo === 'servicio' ? 2 : 1,
      cantidad: l.cantidad,
      codigo: l.producto.codigo ?? null,
      uniMedida: l.producto.uniMedida,
      descripcion: l.producto.nombre,
      precioUni: precio,
      montoDescu: 0,
      compra: round2(precio * l.cantidad),
    };
  });
  return {
    consecutivo: args.consecutivo,
    sujetoExcluido: receptorFseFromContribuyente(args.sujetoExcluido),
    items,
    reteRenta: args.reteRenta ?? 0,
  };
}

/* ─────────────────────── Conversores Contribuyente → Receptor ─────────────────────── */

function receptorFcfFromContribuyente(c: Contribuyente): Record<string, unknown> {
  // Para FCF la mayoría de campos son opcionales. Sólo poblamos lo disponible.
  const dui = (c.dui ?? '').replace(/-/g, '');
  const nit = (c.nit ?? '').replace(/-/g, '');
  const actividad = resolveActividad(c);
  return {
    tipoDocumento: dui ? '13' : (nit ? '36' : null),
    numDocumento: dui || nit || null,
    nrc: (c.nrc ?? '').replace(/-/g, '') || null,
    nombre: c.nombre,
    codActividad: actividad?.codigo ?? null,
    descActividad: actividad?.nombre ?? null,
    direccion: addressFromContribuyente(c),
    telefono: c.telefono || null,
    correo: c.email || null,
  };
}

function receptorCcfFromContribuyente(c: Contribuyente): Record<string, unknown> {
  const actividad = resolveActividad(c) ?? { codigo: '47711', nombre: 'Comercio' };
  return {
    nit: (c.nit ?? '').replace(/-/g, ''),
    nrc: (c.nrc ?? '').replace(/-/g, ''),
    nombre: c.nombre,
    codActividad: actividad.codigo,
    descActividad: actividad.nombre,
    nombreComercial: null,
    telefono: c.telefono || null,
    correo: c.email || 'sin-correo@example.sv',
    direccion: addressFromContribuyente(c) ?? {
      departamento: '06', municipio: '14', complemento: 'San Salvador',
    },
  };
}

function receptorFseFromContribuyente(c: Contribuyente): Record<string, unknown> {
  const dui = (c.dui ?? '').replace(/-/g, '');
  const nit = (c.nit ?? '').replace(/-/g, '');
  const actividad = resolveActividad(c);
  // FSE típico: persona natural por DUI. Fallback a NIT si no hay DUI.
  return {
    tipoDocumento: dui ? '13' : '36',
    numDocumento: dui || nit,
    nombre: c.nombre,
    codActividad: actividad?.codigo ?? null,
    descActividad: actividad?.nombre ?? null,
    telefono: c.telefono || null,
    correo: c.email || null,
    direccion: addressFromContribuyente(c) ?? {
      departamento: '06', municipio: '14', complemento: 'San Salvador',
    },
  };
}

/** Resuelve la actividad económica usando el catálogo MH si codActividad
 *  está presente; cae al `giro` libre si no, o devuelve undefined. */
function resolveActividad(c: Contribuyente): { codigo: string; nombre: string } | undefined {
  if (c.codActividad) {
    const fromCatalog = findActividad(c.codActividad);
    if (fromCatalog) return fromCatalog;
    return { codigo: c.codActividad, nombre: c.giro || 'Actividad económica' };
  }
  if (c.giro) {
    return { codigo: '00000', nombre: c.giro };  // sin código MH; el giro queda como nombre
  }
  return undefined;
}

/** Convierte los campos de dirección estructurada a la forma del schema MH.
 *  Si faltan departamento/municipio devuelve null para que el caller decida. */
function addressFromContribuyente(c: Contribuyente): {
  departamento: string; municipio: string; complemento: string;
} | null {
  if (!c.departamento || !c.municipio) return null;
  return {
    departamento: c.departamento,
    municipio: c.municipio,
    complemento: (c.direccion ?? '').slice(0, 200) || c.nombre,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
