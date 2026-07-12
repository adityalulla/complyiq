import { prisma } from '../db';

function periodToDateRange(period: string) {
  const [year, month] = period.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59));
  return { start, end };
}

/** GSTR-1 + GSTR-3B side by side for one month, pulled from already-prepared filings if they exist. */
export async function buildMonthlyGstReport(businessId: string, period: string) {
  const filings = await prisma.filing.findMany({ where: { businessId, period } });
  const gstr1 = filings.find((f) => f.returnType === 'GSTR_1');
  const gstr3b = filings.find((f) => f.returnType === 'GSTR_3B');

  return {
    reportType: 'monthly_gst_report',
    period,
    gstr1: gstr1 ? { status: gstr1.status, ...(gstr1.preparedData as object) } : 'Not yet prepared',
    gstr3b: gstr3b ? { status: gstr3b.status, ...(gstr3b.preparedData as object) } : 'Not yet prepared',
  };
}

/** Filing history and compliance score for the calendar year. */
export async function buildAnnualComplianceReport(businessId: string, year: number) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  const filings = await prisma.filing.findMany({
    where: { businessId, period: { startsWith: `${year}-` } },
    orderBy: { period: 'asc' },
  });

  const onTime = filings.filter((f) => f.status === 'FILED' && f.submittedAt && f.submittedAt <= f.dueDate).length;
  const late = filings.filter((f) => f.status === 'FILED' && f.submittedAt && f.submittedAt > f.dueDate).length;
  const pending = filings.filter((f) => !['FILED', 'SUBMITTED'].includes(f.status)).length;

  return {
    reportType: 'annual_compliance_report',
    year,
    currentComplianceHealthScore: business?.complianceHealthScore ?? null,
    totalFilings: filings.length,
    filedOnTime: onTime,
    filedLate: late,
    stillPending: pending,
    filings: filings.map((f) => ({
      returnType: f.returnType,
      period: f.period,
      status: f.status,
      dueDate: f.dueDate,
      submittedAt: f.submittedAt,
    })),
  };
}

/** Every unresolved (and recently resolved) mismatch, grouped by supplier. */
export async function buildVendorMismatchReport(businessId: string) {
  const results = await prisma.reconciliationResult.findMany({
    where: { businessId, status: { not: 'MATCHED' } },
    include: { invoice: true, gstReturnEntry: true },
    orderBy: { detectedAt: 'desc' },
  });

  const bySupplier = new Map<string, typeof results>();
  for (const r of results) {
    const supplier = r.invoice?.supplierOrCustomerName || r.gstReturnEntry?.supplierGstin || 'Unknown supplier';
    if (!bySupplier.has(supplier)) bySupplier.set(supplier, []);
    bySupplier.get(supplier)!.push(r);
  }

  return {
    reportType: 'vendor_mismatch_report',
    suppliers: Array.from(bySupplier.entries()).map(([supplier, issues]) => ({
      supplier,
      issueCount: issues.length,
      unresolvedCount: issues.filter((i) => !i.resolved).length,
      issues: issues.map((i) => ({
        status: i.status,
        invoiceNumber: i.invoice?.invoiceNumber,
        differenceAmount: i.differenceAmount,
        resolved: i.resolved,
        detectedAt: i.detectedAt,
      })),
    })),
  };
}

/** Output tax vs input credit for a given month - the same numbers behind GSTR-3B. */
export async function buildTaxLiabilityReport(businessId: string, period: string) {
  const { start, end } = periodToDateRange(period);

  const [salesInvoices, purchaseInvoices] = await Promise.all([
    prisma.invoice.findMany({ where: { businessId, direction: 'SALES', invoiceDate: { gte: start, lte: end } } }),
    prisma.invoice.findMany({ where: { businessId, direction: 'PURCHASE', invoiceDate: { gte: start, lte: end } } }),
  ]);

  const outputTax = salesInvoices.reduce((sum, i) => sum + Number(i.gstAmount), 0);
  const inputCredit = purchaseInvoices.reduce((sum, i) => sum + Number(i.gstAmount), 0);

  return {
    reportType: 'tax_liability_report',
    period,
    outputTax,
    inputCredit,
    netTaxPayable: outputTax - inputCredit,
    salesInvoiceCount: salesInvoices.length,
    purchaseInvoiceCount: purchaseInvoices.length,
  };
}

/** Line-by-line ITC claimed for the month, flagging which invoices are at risk. */
export async function buildItcReport(businessId: string, period: string) {
  const { start, end } = periodToDateRange(period);

  const purchaseInvoices = await prisma.invoice.findMany({
    where: { businessId, direction: 'PURCHASE', invoiceDate: { gte: start, lte: end } },
    include: { reconciliationResults: { where: { resolved: false } } },
  });

  const lines = purchaseInvoices.map((inv) => ({
    invoiceNumber: inv.invoiceNumber,
    supplier: inv.supplierOrCustomerName,
    taxableValue: Number(inv.taxableValue),
    gstAmount: Number(inv.gstAmount),
    atRisk: inv.reconciliationResults.length > 0,
    riskReason: inv.reconciliationResults.map((r) => r.status).join(', ') || null,
  }));

  return {
    reportType: 'itc_report',
    period,
    totalItcClaimed: lines.reduce((sum, l) => sum + l.gstAmount, 0),
    totalAtRisk: lines.filter((l) => l.atRisk).reduce((sum, l) => sum + l.gstAmount, 0),
    lines,
  };
}
