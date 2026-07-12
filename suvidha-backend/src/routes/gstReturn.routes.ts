import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';

export const gstReturnRouter = Router();

const entrySchema = z.object({
  invoiceNumber: z.string().min(1),
  supplierGstin: z.string().optional(),
  reportedTaxableValue: z.coerce.number(),
  reportedGstAmount: z.coerce.number(),
  reportedGstRate: z.coerce.number(),
  returnPeriod: z.string().min(1), // e.g. "2026-07"
});

const bulkUploadSchema = z.object({
  entries: z.array(entrySchema).min(1).max(1000),
});

/**
 * POST /businesses/:businessId/gst-return-entries/upload
 *
 * Milestone 5 replaces this with a real, automatic pull of GSTR-2A/2B data
 * through a licensed GSP partner (see the architecture doc - this data can't
 * legally be pulled directly from the government's systems without one).
 * Until then, this lets you manually import a batch (e.g. exported from the
 * GST portal by hand, or pasted in from a CA) so the reconciliation engine
 * has real government-side data to compare against.
 */
gstReturnRouter.post(
  '/:businessId/gst-return-entries/upload',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const parsed = bulkUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { businessId } = req.params;

    const created = await prisma.gstReturnEntry.createMany({
      data: parsed.data.entries.map((e) => ({ businessId, ...e })),
    });

    await prisma.auditLog.create({
      data: {
        businessId,
        userId: req.user!.userId,
        action: 'gst_return_entries_uploaded',
        targetType: 'gst_return_entry',
        metadata: { count: created.count },
      },
    });

    return res.status(201).json({ imported: created.count });
  }
);

gstReturnRouter.get(
  '/:businessId/gst-return-entries',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const entries = await prisma.gstReturnEntry.findMany({
      where: { businessId: req.params.businessId },
      orderBy: { fetchedAt: 'desc' },
    });
    return res.json(entries);
  }
);
