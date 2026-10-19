// =============================================================================
// DUCA (Declaración Única Centroamericana) as read from its PDF — shared by the
// extraction endpoint (api/purchases/duca.ts), the review screen and the checks.
// Amounts in US$ as printed. Tax codes as the DUCA prints them: DAI, IVA, VTS,
// ITS, AIV... Only IVA is crédito fiscal; every other tributo is import cost.
// =============================================================================

export interface DucaTax {
  /** DAI, IVA, VTS, ITS, AIV... */
  code: string
  /** Percentage as printed (15.00 = 15%); null when the DUCA shows none */
  rate: number | null
  amount: number
}

export interface DucaLine {
  line_no: number
  hs_code: string | null
  description: string
  origin_country: string | null
  quantity: number
  unit: string | null
  fob: number
  freight: number
  insurance: number
  other_costs: number
  customs_value: number
  taxes: DucaTax[]
}

export interface DucaDocument {
  /** 54.1 código tipo de documento: 380 factura comercial, 705 conocimiento de embarque... */
  code: string
  number: string
  amount: number | null
}

export interface DucaData {
  duca_number: string
  reference_number: string | null
  /** YYYY-MM-DD (3 Fecha de aceptación) */
  acceptance_date: string
  importer_nit: string | null
  importer_name: string | null
  exporter_name: string | null
  exporter_country: string | null
  declarant_name: string | null
  regime: string | null
  customs_office: string | null
  incoterm: string | null
  exchange_rate: number | null
  /** Commercial invoice number (document code 380) */
  invoice_number: string | null
  fob: number
  freight: number
  insurance: number
  other_costs: number
  customs_value: number
  /** Liquidación general: one entry per tributo */
  taxes: DucaTax[]
  total_taxes: number
  lines: DucaLine[]
  documents: DucaDocument[]
  /** What the reader could not read with confidence */
  notes: string | null
}
