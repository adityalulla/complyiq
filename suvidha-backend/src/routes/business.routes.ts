import { Router } from 'express';
import { z } from 'zod';
import { BusinessRole, BusinessType, FilingFrequency } from '@prisma/client';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';

export const businessRouter = Router();

// Indian GSTIN format: 2-digit state code + 10-char PAN + entity code + 'Z' + checksum
const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

const createBusinessSchema = z.object({
  businessName: z.string().min(2),
  businessType: z.nativeEnum(BusinessType),
  gstin: z.string().regex(GSTIN_REGEX, 'That does not look like a valid GSTIN'),
  pan: z.string().regex(PAN_REGEX, 'That does not look like a valid PAN'),
  filingFrequency: z.nativeEnum(FilingFrequency),
});

// POST /businesses - onboarding step 1. The creator automatically becomes the OWNER.
businessRouter.post('/', requireAuth, async (req, res) => {
  const parsed = createBusinessSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const existingGstin = await prisma.business.findUnique({
    where: { gstin: parsed.data.gstin },
  });
  if (existingGstin) {
    return res.status(409).json({ error: 'A business with this GSTIN is already registered' });
  }

  // Business creation + linking the creator as OWNER happen together, in one
  // transaction, so we never end up with a business that has no owner.
  const business = await prisma.$transaction(async (tx) => {
    const created = await tx.business.create({ data: parsed.data });
    await tx.businessUser.create({
      data: {
        businessId: created.id,
        userId: req.user!.userId,
        role: BusinessRole.OWNER,
      },
    });
    await tx.auditLog.create({
      data: {
        businessId: created.id,
        userId: req.user!.userId,
        action: 'business_created',
        targetType: 'business',
        targetId: created.id,
      },
    });
    return created;
  });

  return res.status(201).json(business);
});

// GET /businesses/:businessId - any linked user (any role) can view the profile.
businessRouter.get(
  '/:businessId',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const business = await prisma.business.findUnique({
      where: { id: req.params.businessId },
    });
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    return res.json(business);
  }
);

const patchBusinessSchema = z.object({
  businessName: z.string().min(2).optional(),
  filingFrequency: z.nativeEnum(FilingFrequency).optional(),
});

// PATCH /businesses/:businessId - only Owner/Admin can edit core business details.
businessRouter.patch(
  '/:businessId',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const parsed = patchBusinessSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const business = await prisma.business.update({
      where: { id: req.params.businessId },
      data: parsed.data,
    });

    await prisma.auditLog.create({
      data: {
        businessId: business.id,
        userId: req.user!.userId,
        action: 'business_updated',
        targetType: 'business',
        targetId: business.id,
        metadata: parsed.data,
      },
    });

    return res.json(business);
  }
);

// GET /businesses/:businessId/users - list the team. Owner/Admin only,
// since this reveals who has access to sensitive filings.
businessRouter.get(
  '/:businessId/users',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const links = await prisma.businessUser.findMany({
      where: { businessId: req.params.businessId },
      include: { user: true },
    });

    return res.json(
      links.map((link) => ({
        userId: link.user.id,
        name: link.user.name,
        email: link.user.email,
        role: link.role,
      }))
    );
  }
);

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(BusinessRole),
});

// POST /businesses/:businessId/users/invite
// Simplification for Milestone 1: this links an *existing* registered user
// to the business immediately. A real invite flow (email invite for someone
// who hasn't signed up yet, pending-invite state, expiring links) is a
// Milestone 2+ addition once real accountants are using this.
businessRouter.post(
  '/:businessId/users/invite',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const invitedUser = await prisma.user.findUnique({
      where: { email: parsed.data.email },
    });
    if (!invitedUser) {
      return res.status(404).json({
        error: 'No account with this email exists yet. They need to sign up first.',
      });
    }

    const existingLink = await prisma.businessUser.findUnique({
      where: {
        businessId_userId: { businessId: req.params.businessId, userId: invitedUser.id },
      },
    });
    if (existingLink) {
      return res.status(409).json({ error: 'This user already has access to this business' });
    }

    const link = await prisma.businessUser.create({
      data: {
        businessId: req.params.businessId,
        userId: invitedUser.id,
        role: parsed.data.role,
      },
    });

    await prisma.auditLog.create({
      data: {
        businessId: req.params.businessId,
        userId: req.user!.userId,
        action: 'user_invited',
        targetType: 'business_user',
        targetId: link.id,
        metadata: { invitedEmail: parsed.data.email, role: parsed.data.role },
      },
    });

    return res.status(201).json({ message: 'User added to business', role: link.role });
  }
);

const patchRoleSchema = z.object({
  role: z.nativeEnum(BusinessRole),
});

// PATCH /businesses/:businessId/users/:userId/role - Owner/Admin only.
// This is the exact route the RBAC middleware is designed to protect: an
// Accountant's token can never successfully call this, no matter what the UI shows.
businessRouter.patch(
  '/:businessId/users/:userId/role',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const parsed = patchRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const link = await prisma.businessUser.update({
      where: {
        businessId_userId: { businessId: req.params.businessId, userId: req.params.userId },
      },
      data: { role: parsed.data.role },
    });

    await prisma.auditLog.create({
      data: {
        businessId: req.params.businessId,
        userId: req.user!.userId,
        action: 'user_role_changed',
        targetType: 'business_user',
        targetId: link.id,
        metadata: { newRole: parsed.data.role, targetUserId: req.params.userId },
      },
    });

    return res.json({ message: 'Role updated', role: link.role });
  }
);
