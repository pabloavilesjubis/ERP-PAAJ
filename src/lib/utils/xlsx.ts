/**
 * Exportación a Excel (.xlsx) con write-excel-file, cargado bajo demanda para
 * no pesar en la carga inicial de la app.
 */
export interface XlsxCell { value: string | number | null; bold?: boolean; money?: boolean; indent?: number }
export interface XlsxSheet { name: string; rows: XlsxCell[][]; widths?: number[] }

export async function downloadXlsx(fileName: string, sheets: XlsxSheet[]): Promise<void> {
  const { default: writeExcelFile } = await import('write-excel-file/browser');
  const data = sheets.map(s => ({
    sheet: s.name.slice(0, 31),
    columns: s.widths?.map(width => ({ width })),
    data: s.rows.map(row => row.map(c => c.value === null || c.value === '' ? null : {
      value: c.value,
      type: typeof c.value === 'number' ? Number : String,
      format: typeof c.value === 'number' && c.money !== false ? '#,##0.00;(#,##0.00)' : undefined,
      fontWeight: c.bold ? 'bold' as const : undefined,
      indent: c.indent,
    })),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob = await (writeExcelFile as any)(data).toBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
