import { FilingReturnType } from '@prisma/client';
import { prisma } from '../db';

export class FilingLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilingLockedError';
  }
}

/** Turns "2026-07" into the first and last moment of that calendar month. */
function periodToDateRange(period: string): { start: Date; end: Date } {
  const [year, month] = period.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59));
  return { start, end };
}

/**
 * Standard monthly due dates: GSTR-1 by the 11th of the following month,
 * GSTR-3B by the 20th. Businesses on the QRMP quarterly scheme actually have
 * different, quarter-based due dates - this simplified version is a
 * reasonable MVP default, flagged here so it isn't mistaken for the full rule.
 */
function computeDueDate(returnType: FilingReturnType, period: string): Date {
  const [year, month] = period.split('-').map(Number);
  const dueDay = returnType === 'GSTR_1' ? 11 : 20;
  // Due date falls in the month AFTER the period being filed for.
  return new Date(Date.UTC(year, month, dueDay));
}

/**
 * Builds the GSTR-1 (sales) draft: total invoices, taxable value, and output
 * tax payable for the given month, straight from the books.
 */
async function prepareGstr1(businessId: string, period: string) {
  const { start, end } = periodToDateRange(period);

  const salesInvoices = await prisma.invoice.findMany({
    where: { businessId, direction: 'SALES', invoiceDate: { gte: start, lte: end } },
  });

  const totalTaxableValue = salesInvoices.reduce((sum, i) => sum + Number(i.taxableValue), 0);
  const totalGstPayable = salesInvoices.reduce((sum, i) => sum + Number(i.gstAmount), 0);

  return {
    totalInvoices: salesInvoices.length,
    totalTaxableValue,
    totalGstPayable,
  };
}

/**
 * Builds the GSTR-3B (summary) draft: total ITC claimed from purchases this
 * month, how much of that is "at risk" because of unresolved reconciliation
 * issues, and the net tax payable after applying that credit.
 */
async function prepareGstr3b(businessId: string, period: string) {
  const { start, end } = periodToDateRange(period);

  const purchaseInvoices = await prisma.invoice.findMany({
    where: { businessId, direction: 'PURCHASE', invoiceDate: { gte: start, lte: end } },
    include: {
      reconciliationResults: { where: { resolved: false } },
    },
  });

  const totalItcClaimed = purchaseInvoices.reduce((sum, i) => sum + Number(i.gstAmount), 0);

  const atRiskInvoices = purchaseInvoices.filter((i) =>
    i.reconciliationResults.some((r) =>
      ['AMOUNT_MISMATCH', 'WRONG_GST_RATE', 'DUPLICATE', 'MISSING_IN_RETURN'].includes(r.status)
    )
  );
  const itcAtRisk = atRiskInvoices.reduce((sum, i) => sum + Number(i.gstAmount), 0);
  const unresolvedIssueCount = atRiskInvoices.length;

  // Net tax payable needs this period's output tax too.
  const gstr1Draft = await prepareGstr1(businessId, period);
  const netTaxPayable = gstr1Draft.totalGstPayable - totalItcClaimed;

  return {
    totalItcClaimed,
    itcAtRisk,
    unresolvedIssueCount,
    outputTaxPayable: gstr1Draft.totalGstPayable,
    netTaxPayable,
  };
}

/**
 * Creates (or refreshes, if still in DRAFT/READY_FOR_REVIEW) the filing
 * record for a given business, return type, and period. Once a filing has
 * been approved or submitted, re-preparing is blocked - the numbers behind
 * an approval should never silently change afterward.
 */
export async function prepareFiling(
  businessId: string,
  returnType: FilingReturnType,
  period: string
) {
  const existing = await prisma.filing.findUnique({
    where: { businessId_returnType_period: { businessId, returnType, period } },
  });

  if (existing && !['DRAFT', 'READY_FOR_REVIEW'].includes(existing.status)) {
    throw new FilingLockedError(
      `This ${returnType} filing for ${period} is already ${existing.status.toLowerCase()} and can't be re-prepared.`
    );
  }

  const preparedData =
    returnType === 'GSTR_1'
      ? await prepareGstr1(businessId, period)
      : await prepareGstr3b(businessId, period);

  const dueDate = computeDueDate(returnType, period);

  const filing = await prisma.filing.upsert({
    where: { businessId_returnType_period: { businessId, returnType, period } },
    update: { preparedData, status: 'READY_FOR_REVIEW', dueDate },
    create: {
      businessId,
      returnType,
      period,
      status: 'READY_FOR_REVIEW',
      preparedData,
      dueDate,
    },
  });

  return filing;
}
