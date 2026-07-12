import { Request, Response, NextFunction } from 'express';
import { BusinessRole } from '@prisma/client';
import { prisma } from '../db';

declare global {
  namespace Express {
    interface Request {
      businessRole?: BusinessRole;
    }
  }
}

/**
 * Enforces role-based access at the API level - not just hidden in the UI.
 * This is the middleware referenced in the security architecture doc: an
 * Accountant's token should be *incapable* of hitting an owner-only route,
 * regardless of what the frontend shows or hides.
 *
 * Usage: router.post('/:businessId/filings/:id/approve', requireAuth, requireRole('OWNER', 'ADMIN'), handler)
 */
export function requireRole(...allowedRoles: BusinessRole[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const { businessId } = req.params;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const link = await prisma.businessUser.findUnique({
      where: { businessId_userId: { businessId, userId } },
    });

    if (!link) {
      return res.status(403).json({ error: 'You do not have access to this business' });
    }

    if (!allowedRoles.includes(link.role)) {
      return res.status(403).json({
        error: `This action requires one of these roles: ${allowedRoles.join(', ')}. Your role is ${link.role}.`,
      });
    }

    req.businessRole = link.role;
    next();
  };
}
