import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ReconciliationStatus } from '@prisma/client';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { runReconciliation } from '../services/reconciliation.service';

export const reconciliationRouter = Router();

// POST /businesses/:businessId/reconciliation/run
// In production this also runs automatically after every invoice sync -
// exposed here too so it can be triggered on demand (e.g. a "Refresh" button).
reconciliationRouter.post(
  '/:businessId/reconciliation/run',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const result = await runReconciliation(req.params.businessId);

       return res.json(result);
  }
);

const listQuerySchema = z.object({
  status: z.nativeEnum(ReconciliationStatus).optional(),
  resolved: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
});

// GET /businesses/:businessId/reconciliation/results
reconciliationRouter.get(
  '/:businessId/reconciliation/results',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req: Request, res: Response) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { status, resolved, page, pageSize } = parsed.data;

    const where: any = { businessId: req.params.businessId };
    if (status) where.status = status;
    if (resolved !== undefined) where.resolved = resolved;

    const [results, total] = await Promise.all([
      prisma.reconciliationResult.findMany({
        where,
        include: { invoice: true, gstReturnEntry: true },
        orderBy: { detectedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.reconciliationResult.count({ where }),
    ]);

    return res.json({
      results,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  }
);

// GET /businesses/:businessId/reconciliation/results/:id
// Powers the comparison drawer shown in the frontend prototype.
reconciliationRouter.get(
  '/:businessId/reconciliation/results/:id',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req: Request, res: Response) => {
    const result = await prisma.reconciliationResult.findFirst({
      where: { id: req.params.id, businessId: req.params.businessId },
      include: { invoice: true, gstReturnEntry: true },
    });
    if (!result) {
      return res.status(404).json({ error: 'Reconciliation result not found' });
    }
    return res.json(result);
  }
);

const resolveSchema = z.object({
  resolutionNote: z.string().min(1, 'Please add a short note on how this was resolved'),
});

// PATCH /businesses/:businessId/reconciliation/results/:id/resolve
reconciliationRouter.patch(
  '/:businessId/reconciliation/results/:id/resolve',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req: Request, res: Response) => {
    const parsed = resolveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const result = await prisma.reconciliationResult.update({
      where: { id: req.params.id },
      data: {
        resolved: true,
        resolvedBy: req.user!.userId,
        resolutionNote: parsed.data.resolutionNote,
      },
    });

    return res.json(result);
  }
);
