import { Prisma, ReconciliationStatus } from '@prisma/client';
import { prisma } from '../db';
import { createAndSendNotification } from './notification.service';

const VALID_GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];
// Anything less than this is treated as a rounding difference, not a real
// mismatch worth flagging - avoids crying wolf over paisa-level gaps.
const AMOUNT_MISMATCH_THRESHOLD = 1;

function normalizeInvoiceNumber(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Runs a full reconciliation pass for one business:
 *   1. Matches purchase invoices (the books) against GST return entries
 *      (what suppliers/the government say) to find amount mismatches,
 *      wrong GST rates, and invoices missing on either side.
 *   2. Separately scans invoices for likely duplicates.
 *
 * This re-runs from scratch each time and replaces any *unresolved* prior
 * results - anything a human already marked resolved is left untouched, so
 * resolving an issue doesn't get silently undone by the next sync.
 */
export async function runReconciliation(businessId: string) {
  const [invoices, returnEntries] = await Promise.all([
    prisma.invoice.findMany({ where: { businessId, direction: 'PURCHASE' } }),
    prisma.gstReturnEntry.findMany({ where: { businessId } }),
  ]);

  // Clear out previous unresolved results before writing fresh ones.
  await prisma.reconciliationResult.deleteMany({ where: { businessId, resolved: false } });

  const newResults: Prisma.ReconciliationResultCreateManyInput[] = [];

  // ---- 1. Match invoices <-> GST return entries ----
  const matchKey = (invoiceNumber: string, gstin?: string | null) =>
    `${normalizeInvoiceNumber(invoiceNumber)}::${(gstin || '').trim().toUpperCase()}`;

  const returnEntryByKey = new Map(
    returnEntries.map((entry) => [matchKey(entry.invoiceNumber, entry.supplierGstin), entry])
  );
  const matchedReturnEntryIds = new Set<string>();

  for (const invoice of invoices) {
    const key = matchKey(invoice.invoiceNumber, invoice.supplierGstin);
    const returnEntry = returnEntryByKey.get(key);

    if (!returnEntry) {
      // In the books, but the supplier hasn't reported it (or hasn't filed yet).
      newResults.push({
        businessId,
        invoiceId: invoice.id,
        status: ReconciliationStatus.MISSING_IN_RETURN,
      });
      continue;
    }

    matchedReturnEntryIds.add(returnEntry.id);

    const taxableDiff = Math.abs(
      Number(invoice.taxableValue) - Number(returnEntry.reportedTaxableValue)
    );
    const gstDiff = Math.abs(Number(invoice.gstAmount) - Number(returnEntry.reportedGstAmount));

    if (taxableDiff > AMOUNT_MISMATCH_THRESHOLD || gstDiff > AMOUNT_MISMATCH_THRESHOLD) {
      newResults.push({
        businessId,
        invoiceId: invoice.id,
        gstReturnEntryId: returnEntry.id,
        status: ReconciliationStatus.AMOUNT_MISMATCH,
        differenceAmount: taxableDiff + gstDiff,
      });
      continue;
    }

    const rateDiff = Math.abs(Number(invoice.gstRate) - Number(returnEntry.reportedGstRate));
    if (rateDiff > 0.01 || !VALID_GST_RATES.includes(Number(invoice.gstRate))) {
      newResults.push({
        businessId,
        invoiceId: invoice.id,
        gstReturnEntryId: returnEntry.id,
        status: ReconciliationStatus.WRONG_GST_RATE,
      });
      continue;
    }

    newResults.push({
      businessId,
      invoiceId: invoice.id,
      gstReturnEntryId: returnEntry.id,
      status: ReconciliationStatus.MATCHED,
    });
  }

  // Return entries that never matched any invoice in the books at all.
  for (const entry of returnEntries) {
    if (!matchedReturnEntryIds.has(entry.id)) {
      newResults.push({
        businessId,
        gstReturnEntryId: entry.id,
        status: ReconciliationStatus.MISSING_IN_BOOKS,
      });
    }
  }

  // ---- 2. Duplicate detection within the books themselves ----
  // Two different invoice rows that look like the same real invoice: same
  // supplier, same amount, same date, but entered under (near-)duplicate
  // invoice numbers - a common way duplicate ITC claims sneak in.
  const seen = new Map<string, string>(); // dedupe-signature -> first invoice id
  for (const invoice of invoices) {
    const signature = `${invoice.supplierOrCustomerName.trim().toLowerCase()}::${Number(
      invoice.totalAmount
    )}::${invoice.invoiceDate.toISOString().slice(0, 10)}`;

    if (seen.has(signature)) {
      newResults.push({
        businessId,
        invoiceId: invoice.id,
        status: ReconciliationStatus.DUPLICATE,
      });
    } else {
      seen.set(signature, invoice.id);
    }
  }

  if (newResults.length > 0) {
    await prisma.reconciliationResult.createMany({ data: newResults });
  }

  const summary = newResults.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  const actionableCount = newResults.filter((r) => r.status !== ReconciliationStatus.MATCHED).length;
  if (actionableCount > 0) {
    const owners = await prisma.businessUser.findMany({
      where: { businessId, role: { in: ['OWNER', 'ADMIN'] } },
      include: { user: true },
    });
    for (const owner of owners) {
      await createAndSendNotification({
        businessId,
        userId: owner.userId,
        type: 'MISMATCH_ALERT',
        channel: 'EMAIL',
        sendTo: owner.user.email,
        message: `Reconciliation found ${actionableCount} issue(s) that need your attention. Log in to review before your next filing.`,
      });
    }
  }

  return { totalFlagged: newResults.length, breakdown: summary };
}
