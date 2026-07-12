import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { sendMessage } from '../services/ai.service';

export const aiRouter = Router();

// POST /businesses/:businessId/ai/conversations - start a new conversation.
aiRouter.post(
  '/:businessId/ai/conversations',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const conversation = await prisma.aiConversation.create({
      data: { businessId: req.params.businessId, userId: req.user!.userId },
    });
    return res.status(201).json(conversation);
  }
);

// GET /businesses/:businessId/ai/conversations/:id - full history.
aiRouter.get(
  '/:businessId/ai/conversations/:id',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const conversation = await prisma.aiConversation.findFirst({
      where: { id: req.params.id, businessId: req.params.businessId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    return res.json(conversation);
  }
);

const sendMessageSchema = z.object({
  content: z.string().min(1).max(2000),
  // Optional - lets the frontend say "explain this specific invoice" (e.g.
  // clicking "Ask AI to explain" from the reconciliation drawer) so the
  // model gets that issue's exact data instead of guessing which one you mean.
  focusInvoiceId: z.string().uuid().optional(),
});

// POST /businesses/:businessId/ai/conversations/:id/messages
aiRouter.post(
  '/:businessId/ai/conversations/:id/messages',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const conversation = await prisma.aiConversation.findFirst({
      where: { id: req.params.id, businessId: req.params.businessId },
    });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    try {
      const reply = await sendMessage(
        req.params.id,
        req.params.businessId,
        parsed.data.content,
        parsed.data.focusInvoiceId
      );
      return res.status(201).json(reply);
    } catch (err) {
      console.error('AI assistant error:', err);
      return res.status(502).json({
        error: 'The AI assistant is temporarily unavailable. Please try again shortly.',
      });
    }
  }
);
