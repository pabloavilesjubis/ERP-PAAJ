import { describe, expect, it } from 'vitest';
import { buildDtePdf, type PdfData } from './pdf';

const base: PdfData = {
  tipo: 'ccf', codigoGeneracion: '1A2B3C4D-0000-4000-8000-00000000ABCD', numeroControl: 'DTE-03-M001P001-000000000000001',
  selloRecibido: '2026' + 'A'.repeat(36), fecha: '2026-10-30', horaEmision: '10:00:00', ambiente: '01', anulado: false,
  emisor: { nombre: 'EMPRESA DE PRUEBA SA DE CV', nit: '06140101261234', nrc: '1234567', actividad: 'Servicios', direccion: 'San Salvador', correo: 'fe@test.sv' },
  receptor: { nombre: 'CLIENTE SA DE CV', nit: '06140101269999', nrc: '7654321' },
  items: [{ descripcion: 'Servicio', cantidad: 1, precioUni: 100, total: 100 }],
  totales: { subtotal: 100, iva: 13, total: 113 },
  totalEnLetras: 'CIENTO TRECE 00/100 DÓLARES',
};
const text = async (d: PdfData) => (await buildDtePdf(d)).output();

describe('PDF carta del DTE', () => {
  it('trae la identificación que exige la representación gráfica', async () => {
    const t = await text(base);
    for (const s of ['COMPROBANTE DE CR', 'DTE-03-M001P001-000000000000001', '1A2B3C4D-0000-4000-8000-00000000ABCD',
      'Modelo de facturaci'.toUpperCase().slice(0, 10), 'TOTAL A PAGAR', '$113.00', 'gina 1 de 1']) expect(t).toContain(s);
  });

  it('pagina el detalle largo y marca el anulado', async () => {
    const many = { ...base, anulado: true, items: Array.from({ length: 60 }, (_, i) => ({ descripcion: `Artículo ${i + 1}`, cantidad: 1, precioUni: 1, total: 1 })) };
    const doc = await buildDtePdf(many);
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    const t = doc.output();
    expect(t).toContain('DOCUMENTO ANULADO');
    expect(t).toContain('continuaci');
  });
});
