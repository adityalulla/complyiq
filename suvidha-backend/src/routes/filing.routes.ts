import { Router } from 'express';
import { z } from 'zod';
import { FilingReturnType } from '@prisma/client';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { prepareFiling, FilingLockedError } from '../services/filing.service';
import { createAndSendNotification } from '../services/notification.service';

export const filingRouter = Router();

// GET /businesses/:businessId/filings - list past and upcoming filings.
filingRouter.get(
  '/:businessId/filings',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const filings = await prisma.filing.findMany({
      where: { businessId: req.params.businessId },
      orderBy: { dueDate: 'desc' },
    });
    return res.json(filings);
  }
);

const periodParamSchema = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/, 'Period must be in YYYY-MM format') });
const prepareBodySchema = z.object({ returnType: z.nativeEnum(FilingReturnType) });

// POST /businesses/:businessId/filings/:period/prepare
// Owner/Accountant/Admin can all prepare a draft - preparing is not the same
// as approving, so Accountants are allowed to do this part.
filingRouter.post(
  '/:businessId/filings/:period/prepare',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const periodParsed = periodParamSchema.safeParse(req.params);
    const bodyParsed = prepareBodySchema.safeParse(req.body);
    if (!periodParsed.success) {
      return res.status(400).json({ error: periodParsed.error.errors[0].message });
    }
    if (!bodyParsed.success) {
      return res.status(400).json({ error: bodyParsed.error.errors[0].message });
    }

    try {
      const filing = await prepareFiling(
        req.params.businessId,
        bodyParsed.data.returnType,
        periodParsed.data.period
      );

      await prisma.auditLog.create({
        data: {
          businessId: req.params.businessId,
          userId: req.user!.userId,
          action: 'filing_prepared',
          targetType: 'filing',
          targetId: filing.id,
        },
      });

      return res.status(201).json(filing);
    } catch (err) {
      if (err instanceof FilingLockedError) {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
  }
);

// GET /businesses/:businessId/filings/:id - full summary for the review screen.
filingRouter.get(
  '/:businessId/filings/:id',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const filing = await prisma.filing.findFirst({
      where: { id: req.params.id, businessId: req.params.businessId },
    });
    if (!filing) {
      return res.status(404).json({ error: 'Filing not found' });
    }
    return res.json(filing);
  }
);

// POST /businesses/:businessId/filings/:id/approve
// This is the human-approval gate from the original brief: Owner/Admin ONLY.
// An Accountant's token is structurally incapable of calling this successfully,
// regardless of what any frontend checkbox shows.
filingRouter.post(
  '/:businessId/filings/:id/approve',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const filing = await prisma.filing.findFirst({
      where: { id: req.params.id, businessId: req.params.businessId },
    });
    if (!filing) {
      return res.status(404).json({ error: 'Filing not found' });
    }
    if (filing.status !== 'READY_FOR_REVIEW') {
      return res.status(409).json({
        error: `Only a filing that is READY_FOR_REVIEW can be approved. This one is ${filing.status}.`,
      });
    }

    const updated = await prisma.filing.update({
      where: { id: filing.id },
      data: { status: 'APPROVED', approvedBy: req.user!.userId, approvedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        businessId: req.params.businessId,
        userId: req.user!.userId,
        action: 'filing_approved',
        targetType: 'filing',
        targetId: filing.id,
      },
    });

    return res.json(updated);
  }
);

// POST /businesses/:businessId/filings/:id/submit
//
// IMPORTANT: this does NOT actually submit anything to the real GST portal
// yet - that requires a licensed GSP/ASP partnership, which is Milestone 5.
// For now, "submit" marks the filing FILED with a clearly-fake ARN and makes
// the finished summary available to download/file manually - this still
// delivers real value (an accurate, ready-to-file return) without taking on
// the legal complexity of direct government submission before it's justified.
filingRouter.post(
  '/:businessId/filings/:id/submit',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const filing = await prisma.filing.findFirst({
      where: { id: req.params.id, businessId: req.params.businessId },
    });
    if (!filing) {
      return res.status(404).json({ error: 'Filing not found' });
    }
    if (filing.status !== 'APPROVED') {
      return res.status(409).json({
        error: `Only an APPROVED filing can be submitted. This one is ${filing.status}.`,
      });
    }

    const mockArn = `MOCK-ARN-${Date.now()}`;

    const updated = await prisma.filing.update({
      where: { id: filing.id },
      data: { status: 'FILED', submittedAt: new Date(), gstnArn: mockArn },
    });

    await prisma.auditLog.create({
      data: {
        businessId: req.params.businessId,
        userId: req.user!.userId,
        action: 'filing_submitted',
        targetType: 'filing',
        targetId: filing.id,
        metadata: { note: 'Mock submission - no real GSTN integration yet (Milestone 5)', mockArn },
      },
    });

    const owners = await prisma.businessUser.findMany({
      where: { businessId: req.params.businessId, role: { in: ['OWNER', 'ADMIN'] } },
      include: { user: true },
    });
    for (const owner of owners) {
      await createAndSendNotification({
        businessId: req.params.businessId,
        userId: owner.userId,
        type: 'FILING_CONFIRMATION',
        channel: 'EMAIL',
        sendTo: owner.user.email,
        message: `${filing.returnType} for ${filing.period} has been filed. Reference: ${mockArn}.`,
      });
    }

    return res.json(updated);
  }
);
