import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db';
import { verifyApiKey } from '../utils/apiKey';

declare global {
  namespace Express {
    interface Request {
      integration?: { id: string; businessId: string; provider: string };
    }
  }
}

/**
 * A local sync agent (e.g. the Tally agent running on a client's own machine)
 * has no human logging in - it authenticates with a long-lived API key tied
 * to one specific integration, scoped to one specific business. This is
 * intentionally separate from requireAuth/requireRole, which are for humans.
 */
export async function requireIntegrationKey(req: Request, res: Response, next: NextFunction) {
  const header = req.headers['x-api-key'];
  if (!header || typeof header !== 'string') {
    return res.status(401).json({ error: 'Missing X-API-Key header' });
  }

  const { businessId } = req.params;

  const integration = await prisma.integration.findFirst({
    where: { businessId, status: 'CONNECTED' },
  });

  if (!integration || !integration.apiKeyHash) {
    return res.status(401).json({ error: 'No connected integration found for this business' });
  }

  const valid = await verifyApiKey(header, integration.apiKeyHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.integration = {
    id: integration.id,
    businessId: integration.businessId,
    provider: integration.provider,
  };
  next();
}
