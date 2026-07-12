import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

/**
 * Reports have different shapes (some are nested, some are flat lists), so
 * this flattens whatever "rows" the report exposes into a simple table for
 * CSV/Excel - falls back to a single summary row if there's no obvious list.
 */
function extractRows(report: any): Record<string, any>[] {
  if (Array.isArray(report.lines)) return report.lines;
  if (Array.isArray(report.filings)) return report.filings;
  if (Array.isArray(report.suppliers)) {
    return report.suppliers.map((s: any) => ({
      supplier: s.supplier,
      issueCount: s.issueCount,
      unresolvedCount: s.unresolvedCount,
    }));
  }
  // No obvious row list (e.g. monthly GST report, tax liability report) -
  // export the flat summary fields as a single row instead.
  const { reportType, ...rest } = report;
  return [rest];
}

export function toCsv(report: any): string {
  const rows = extractRows(report);
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => JSON.stringify(row[h] ?? '')).join(','));
  }
  return lines.join('\n');
}

export async function toExcel(report: any): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(report.reportType || 'Report');

  const rows = extractRows(report);
  if (rows.length > 0) {
    sheet.columns = Object.keys(rows[0]).map((key) => ({ header: key, key, width: 20 }));
    sheet.addRows(rows);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer as Buffer;
}

export function toPdf(report: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).text(String(report.reportType || 'Report').replace(/_/g, ' ').toUpperCase());
    doc.moveDown();

    const rows = extractRows(report);
    doc.fontSize(10);
    for (const row of rows) {
      doc.text(Object.entries(row).map(([k, v]) => `${k}: ${v}`).join('  |  '));
      doc.moveDown(0.3);
    }

    doc.end();
  });
}
