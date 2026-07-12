import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';

export const userRouter = Router();

// GET /me - the logged-in user's profile plus every business they're linked to.
// The frontend uses this right after login to decide: does this user already
// have a business (go to dashboard) or not (go to onboarding)?
userRouter.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    include: {
      businessLinks: { include: { business: true } },
    },
  });

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  return res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    businesses: user.businessLinks.map((link) => ({
      id: link.business.id,
      businessName: link.business.businessName,
      role: link.role,
      complianceHealthScore: link.business.complianceHealthScore,
    })),
  });
});
