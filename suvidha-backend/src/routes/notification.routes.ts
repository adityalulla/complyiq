import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { sendUpcomingDeadlineReminders } from '../services/notification.service';

export const notificationRouter = Router();

// GET /businesses/:businessId/notifications - only the logged-in user's own notifications.
notificationRouter.get(
  '/:businessId/notifications',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const notifications = await prisma.notification.findMany({
      where: { businessId: req.params.businessId, userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return res.json(notifications);
  }
);

// PATCH /businesses/:businessId/notifications/:id/read
notificationRouter.patch(
  '/:businessId/notifications/:id/read',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const notification = await prisma.notification.findFirst({
      where: { id: req.params.id, businessId: req.params.businessId, userId: req.user!.userId },
    });
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    const updated = await prisma.notification.update({
      where: { id: notification.id },
      data: { read: true },
    });
    return res.json(updated);
  }
);

// POST /businesses/:businessId/notifications/check-deadlines
// Manually triggers the same check a daily cron job would run - useful for
// testing, and as a fallback if the scheduled job hasn't been set up yet.
notificationRouter.post(
  '/:businessId/notifications/check-deadlines',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (_req, res) => {
    const result = await sendUpcomingDeadlineReminders();
    return res.json(result);
  }
);
