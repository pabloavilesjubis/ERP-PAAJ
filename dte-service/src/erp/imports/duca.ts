import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * Lectura de una DUCA en PDF con Claude (portado de ChuchoWash
 * api/_lib/duca/extract.ts). El modelo solo LEE: el esquema va en el prompt y
 * la respuesta se valida con zod; las validaciones aritméticas (checks.ts) y
 * el contador deciden. Requiere ANTHROPIC_API_KEY en el entorno del backend.
 */

export const DUCA_MODEL = 'claude-opus-5-5';

const money = z.number();
const tax = z.object({ code: z.string(), rate: z.number().nullable(), amount: money });

export const DucaSchema = z.object({
  duca_number: z.string(),
  reference_number: z.string().nullable(),
  acceptance_date: z.string(),
  importer_nit: z.string().nullable(),
  importer_name: z.string().nullable(),
  exporter_name: z.string().nullable(),
  exporter_country: z.string().nullable(),
  declarant_name: z.string().nullable(),
  regime: z.string().nullable(),
  customs_office: z.string().nullable(),
  incoterm: z.string().nullable(),
  exchange_rate: z.number().nullable(),
  invoice_number: z.string().nullable(),
  fob: money, freight: money, insurance: money, other_costs: money, customs_value: money,
  taxes: z.array(tax),
  total_taxes: money,
  lines: z.array(z.object({
    line_no: z.number().int(),
    hs_code: z.string().nullable(),
    description: z.string(),
    origin_country: z.string().nullable(),
    quantity: z.number(),
    unit: z.string().nullable(),
    fob: money, freight: money, insurance: money, other_costs: money, customs_value: money,
    taxes: z.array(tax),
  })),
  documents: z.array(z.object({ code: z.string(), number: z.string(), amount: z.number().nullable() })),
  notes: z.string().nullable(),
});
export type DucaData = z.infer<typeof DucaSchema>;

// zod 3 no genera JSON Schema: el formato va descrito a mano (mismos campos que ChuchoWash)
const FORMAT = `{
  "duca_number": "campo 2 No de DUCA, solo dígitos",
  "reference_number": "campo 1 o null",
  "acceptance_date": "campo 3 Fecha de aceptación como YYYY-MM-DD (el PDF la imprime DD/MM/YYYY)",
  "importer_nit": "campo 5.1, solo dígitos, o null", "importer_name": "texto o null",
  "exporter_name": "campo 4.4 o null", "exporter_country": "campo 4.3 (o país de origen) o null",
  "declarant_name": "campo 6.3 o null", "regime": "campo 11 o null", "customs_office": "campo 7 o null",
  "incoterm": "texto o null", "exchange_rate": número o null,
  "invoice_number": "número del documento 54.2 cuyo código 54.1 es 380, o null",
  "fob": campo 25, "freight": campo 26, "insurance": campo 27, "other_costs": campo 28, "customs_value": campo 29,
  "taxes": [{"code": "DAI|IVA|VTS|ITS|AIV… tal como está impreso", "rate": porcentaje impreso (15.00 = 15%) o null, "amount": monto}],
  "total_taxes": campo 34.4,
  "lines": [{"line_no": campo 40, "hs_code": "campo 45 o null", "description": "campo 46", "origin_country": "campo 41 o null",
             "quantity": campo 43, "unit": "campo 42 o null", "fob": campo 48, "freight": campo 49, "insurance": campo 50,
             "other_costs": campo 51, "customs_value": campo 52, "taxes": [mismo formato, campo 53]}],
  "documents": [{"code": "54.1", "number": "54.2", "amount": 54.8 o null}],
  "notes": "lo que no pudiste leer con seguridad, en español, o null"
}
Montos en US$ como números JSON sin separadores de miles.`;

const PROMPT = `Esta es una Declaración Única Centroamericana (DUCA) de una importación a El Salvador.
Extrae sus datos tal como están impresos, campo por campo, incluyendo TODAS las líneas de mercancías
de todas las hojas (las hojas de ampliación repiten encabezados vacíos: ignora los bloques sin datos).
No calcules ni corrijas montos: copia lo impreso. Si un dato no aparece, usa null; si un monto no
aparece, usa 0. Si algo es ilegible o ambiguo, dilo en "notes".

Responde solo con un objeto JSON (sin texto antes ni después) con esta forma:
${FORMAT}`;

export class DucaReadError extends Error {}

function jsonOf(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new DucaReadError('La lectura de la DUCA no devolvió datos.');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new DucaReadError('La lectura de la DUCA devolvió datos incompletos. Intenta de nuevo.');
  }
}

export async function extractDuca(pdf: Buffer, apiKey: string): Promise<{ data: DucaData; model: string }> {
  const client = new Anthropic({ apiKey });
  // En streaming: un PDF largo con max_tokens alto superaría el timeout de una petición normal
  const stream = client.beta.messages.stream({
    model: DUCA_MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high' },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  const response = await stream.finalMessage();
  if (response.stop_reason === 'refusal') throw new DucaReadError('El lector de IA no procesó el documento.');
  if (response.stop_reason === 'max_tokens') throw new DucaReadError('La DUCA es demasiado larga para leerla de una vez.');
  const text = response.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('');
  const parsed = DucaSchema.safeParse(jsonOf(text));
  if (!parsed.success) throw new DucaReadError('No se pudo leer la DUCA con la estructura esperada. Intenta de nuevo.');
  const data = parsed.data;
  return { data: { ...data, duca_number: data.duca_number.replace(/\D/g, '') }, model: response.model };
}
