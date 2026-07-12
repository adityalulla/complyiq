import { Router } from 'express';
import { z } from 'zod';
import axios from 'axios';
import { IntegrationProvider, IntegrationStatus, InvoiceDirection, InvoiceSource } from '@prisma/client';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { requireIntegrationKey } from '../middleware/integrationAuth';
import { generateApiKey, hashApiKey } from '../utils/apiKey';
import { encryptToken } from '../utils/tokenCrypto';

export const integrationRouter = Router();

const connectSchema = z.object({
  provider: z.nativeEnum(IntegrationProvider),
});

// POST /businesses/:businessId/integrations - start connecting Tally, Zoho, etc.
// For machine-driven providers (Tally), this returns a raw API key ONCE -
// the local sync agent needs it to push data in later. For providers with a
// real OAuth flow (Zoho Books, QuickBooks), this would instead return a
// redirect URL - left as a Milestone 2b addition once Tally sync is proven.
integrationRouter.post(
  '/:businessId/integrations',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const parsed = connectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const existing = await prisma.integration.findUnique({
      where: {
        businessId_provider: { businessId: req.params.businessId, provider: parsed.data.provider },
      },
    });
    if (existing && existing.status === 'CONNECTED') {
      return res.status(409).json({ error: 'This integration is already connected' });
    }

    let rawApiKey: string | null = null;
    let apiKeyHash: string | null = null;

    // Tally has no cloud API of its own - it only exposes a local XML/HTTP
    // interface on the same machine or network it runs on. So instead of an
    // OAuth redirect, we hand the business owner an API key to paste into
    // the small local sync agent (see the separate tally-sync-agent project).
    if (parsed.data.provider === 'TALLY') {
      rawApiKey = generateApiKey();
      apiKeyHash = await hashApiKey(rawApiKey);
    }

    const integration = await prisma.integration.upsert({
      where: {
        businessId_provider: { businessId: req.params.businessId, provider: parsed.data.provider },
      },
      update: { status: IntegrationStatus.CONNECTED, apiKeyHash: apiKeyHash ?? undefined },
      create: {
        businessId: req.params.businessId,
        provider: parsed.data.provider,
        status: IntegrationStatus.CONNECTED,
        apiKeyHash: apiKeyHash ?? undefined,
      },
    });

    await prisma.auditLog.create({
      data: {
        businessId: req.params.businessId,
        userId: req.user!.userId,
        action: 'integration_connected',
        targetType: 'integration',
        targetId: integration.id,
        metadata: { provider: parsed.data.provider },
      },
    });

    return res.status(201).json({
      integration: { id: integration.id, provider: integration.provider, status: integration.status },
      // rawApiKey is returned ONLY in this single response - it can't be retrieved again.
      apiKey: rawApiKey,
    });
  }
);

// GET /businesses/:businessId/integrations - any team member can see connection status.
integrationRouter.get(
  '/:businessId/integrations',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const integrations = await prisma.integration.findMany({
      where: { businessId: req.params.businessId },
      select: { id: true, provider: true, status: true, lastSyncedAt: true },
    });
    return res.json(integrations);
  }
);

// DELETE /businesses/:businessId/integrations/:id - Owner/Admin only.
integrationRouter.delete(
  '/:businessId/integrations/:id',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    await prisma.integration.update({
      where: { id: req.params.id },
      data: { status: IntegrationStatus.DISCONNECTED, apiKeyHash: null },
    });

    await prisma.auditLog.create({
      data: {
        businessId: req.params.businessId,
        userId: req.user!.userId,
        action: 'integration_disconnected',
        targetType: 'integration',
        targetId: req.params.id,
      },
    });

    return res.json({ message: 'Integration disconnected' });
  }
);

// ---- Zoho Books & QuickBooks: real OAuth2 connect flows ----
//
// Unlike Tally, both of these are real cloud services with documented OAuth2
// APIs - so "connecting" here means a normal browser redirect + callback,
// not an API key handed to a local agent. Tokens are encrypted at rest with
// the AES-256-GCM helper in utils/tokenCrypto.ts before being stored.
//
// IMPORTANT: I have not been able to test either flow against the real Zoho
// or Intuit (QuickBooks) servers - that needs a registered developer app on
// each platform and a live redirect, neither of which exist in this sandbox.
// The endpoints, parameter names, and token exchange shape below match each
// provider's published OAuth2 documentation as of this build, but please
// verify against their current docs and test with a real developer account
// before relying on this.

const ZOHO_AUTH_BASE = 'https://accounts.zoho.in/oauth/v2/auth'; // .in for the India data center
const ZOHO_TOKEN_URL = 'https://accounts.zoho.in/oauth/v2/token';
const QUICKBOOKS_AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
const QUICKBOOKS_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// GET /businesses/:businessId/integrations/zoho/connect
// Returns the URL to redirect the business owner's browser to. The frontend
// should open this in a new tab/window rather than calling it as a normal API request.
integrationRouter.get(
  '/:businessId/integrations/zoho/connect',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    if (!process.env.ZOHO_CLIENT_ID || !process.env.ZOHO_REDIRECT_URI) {
      return res.status(500).json({ error: 'Zoho OAuth is not configured on this server yet' });
    }
    const params = new URLSearchParams({
      scope: 'ZohoBooks.fullaccess.all',
      client_id: process.env.ZOHO_CLIENT_ID,
      response_type: 'code',
      redirect_uri: process.env.ZOHO_REDIRECT_URI,
      access_type: 'offline', // needed to get a refresh token back, not just a short-lived access token
      // NOTE: for production, sign/encode businessId + a nonce here instead of
      // passing it raw, so the callback can't be forged by guessing a businessId.
      state: req.params.businessId,
    });
    return res.json({ authorizationUrl: `${ZOHO_AUTH_BASE}?${params.toString()}` });
  }
);

// GET /integrations/zoho/callback?code=...&state=<businessId>
// Zoho redirects the user's browser back here after they approve access.
integrationRouter.get('/integrations/zoho/callback', async (req, res) => {
  const { code, state: businessId } = req.query as { code?: string; state?: string };
  if (!code || !businessId) {
    return res.status(400).json({ error: 'Missing code or state from Zoho redirect' });
  }

  try {
    const tokenResponse = await axios.post(ZOHO_TOKEN_URL, null, {
      params: {
        grant_type: 'authorization_code',
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        redirect_uri: process.env.ZOHO_REDIRECT_URI,
        code,
      },
    });
    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    // Zoho Books scopes data under an "organization" - fetch which one this
    // user has access to so future API calls know which org to read from.
    const orgResponse = await axios.get('https://www.zohoapis.in/books/v3/organizations', {
      headers: { Authorization: `Zoho-oauthtoken ${access_token}` },
    });
    const organizationId = orgResponse.data?.organizations?.[0]?.organization_id ?? null;

    await prisma.integration.upsert({
      where: { businessId_provider: { businessId, provider: 'ZOHO_BOOKS' } },
      update: {
        status: 'CONNECTED',
        accessTokenEncrypted: encryptToken(access_token),
        refreshTokenEncrypted: encryptToken(refresh_token),
        tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
        externalOrgId: organizationId,
      },
      create: {
        businessId,
        provider: 'ZOHO_BOOKS',
        status: 'CONNECTED',
        accessTokenEncrypted: encryptToken(access_token),
        refreshTokenEncrypted: encryptToken(refresh_token),
        tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
        externalOrgId: organizationId,
      },
    });

    // Redirect back into the app's integrations screen - adjust to your real frontend URL.
    return res.redirect(`${process.env.FRONTEND_URL || ''}/settings/integrations?connected=zoho`);
  } catch (err: any) {
    console.error('Zoho OAuth callback failed:', err.response?.data || err.message);
    return res.status(502).json({ error: 'Failed to complete Zoho Books connection' });
  }
});

// GET /businesses/:businessId/integrations/quickbooks/connect
integrationRouter.get(
  '/:businessId/integrations/quickbooks/connect',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    if (!process.env.QUICKBOOKS_CLIENT_ID || !process.env.QUICKBOOKS_REDIRECT_URI) {
      return res.status(500).json({ error: 'QuickBooks OAuth is not configured on this server yet' });
    }
    const params = new URLSearchParams({
      client_id: process.env.QUICKBOOKS_CLIENT_ID,
      scope: 'com.intuit.quickbooks.accounting',
      redirect_uri: process.env.QUICKBOOKS_REDIRECT_URI,
      response_type: 'code',
      state: req.params.businessId, // same CSRF caveat as the Zoho flow above
    });
    return res.json({ authorizationUrl: `${QUICKBOOKS_AUTH_BASE}?${params.toString()}` });
  }
);

// GET /integrations/quickbooks/callback?code=...&state=<businessId>&realmId=...
// QuickBooks uniquely also returns a "realmId" - that's the company/account
// ID every future API call needs, equivalent to Zoho's organization_id.
integrationRouter.get('/integrations/quickbooks/callback', async (req, res) => {
  const { code, state: businessId, realmId } = req.query as {
    code?: string;
    state?: string;
    realmId?: string;
  };
  if (!code || !businessId || !realmId) {
    return res.status(400).json({ error: 'Missing code, state, or realmId from QuickBooks redirect' });
  }

  try {
    const basicAuth = Buffer.from(
      `${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`
    ).toString('base64');

    const tokenResponse = await axios.post(
      QUICKBOOKS_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.QUICKBOOKS_REDIRECT_URI as string,
      }),
      { headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    await prisma.integration.upsert({
      where: { businessId_provider: { businessId, provider: 'QUICKBOOKS' } },
      update: {
        status: 'CONNECTED',
        accessTokenEncrypted: encryptToken(access_token),
        refreshTokenEncrypted: encryptToken(refresh_token),
        tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
        externalOrgId: realmId,
      },
      create: {
        businessId,
        provider: 'QUICKBOOKS',
        status: 'CONNECTED',
        accessTokenEncrypted: encryptToken(access_token),
        refreshTokenEncrypted: encryptToken(refresh_token),
        tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
        externalOrgId: realmId,
      },
    });

    return res.redirect(`${process.env.FRONTEND_URL || ''}/settings/integrations?connected=quickbooks`);
  } catch (err: any) {
    console.error('QuickBooks OAuth callback failed:', err.response?.data || err.message);
    return res.status(502).json({ error: 'Failed to complete QuickBooks connection' });
  }
});

// ---- Busy: same situation as Tally - no cloud API, needs a local agent ----
// Busy Accounting Software (common among Indian SMBs alongside Tally) is
// also primarily an on-premise Windows application without a public cloud
// API for most versions. The correct integration pattern is the same one
// used for Tally: a small local agent + the existing API-key auth. Rather
// than duplicate the whole Tally agent project for a second desktop
// accounting tool without being able to test against a real Busy
// installation, this is flagged here as the next step to build the same way
// - see suvidha-tally-agent/ as the template to copy and adapt.

// ---- Machine-to-machine endpoint: called by the local Tally sync agent ----

const tallyInvoiceSchema = z.object({
  invoiceNumber: z.string().min(1),
  direction: z.nativeEnum(InvoiceDirection),
  partyName: z.string().min(1),
  partyGstin: z.string().optional(),
  invoiceDate: z.string(), // ISO date string
  taxableValue: z.number(),
  gstRate: z.number(),
  gstAmount: z.number(),
  totalAmount: z.number(),
});

const tallySyncSchema = z.object({
  invoices: z.array(tallyInvoiceSchema).min(1).max(500),
});

// POST /businesses/:businessId/integrations/tally/sync
// The local sync agent calls this repeatedly (e.g. every hour) with a batch
// of vouchers it just read out of Tally. Authenticated by API key, not a user
// login, since no human is present when this runs.
integrationRouter.post(
  '/:businessId/integrations/tally/sync',
  requireIntegrationKey,
  async (req, res) => {
    const parsed = tallySyncSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { businessId } = req.params;
    let created = 0;
    let skipped = 0;

    // Upsert one at a time so a single bad row doesn't fail the whole batch -
    // important since this may run unattended overnight.
    for (const inv of parsed.data.invoices) {
      try {
        await prisma.invoice.upsert({
          where: {
            businessId_invoiceNumber_direction: {
              businessId,
              invoiceNumber: inv.invoiceNumber,
              direction: inv.direction,
            },
          },
          update: {}, // if it already exists, leave it - don't silently overwrite reconciled data
          create: {
            businessId,
            invoiceNumber: inv.invoiceNumber,
            direction: inv.direction,
            supplierOrCustomerName: inv.partyName,
            supplierGstin: inv.partyGstin,
            invoiceDate: new Date(inv.invoiceDate),
            taxableValue: inv.taxableValue,
            gstRate: inv.gstRate,
            gstAmount: inv.gstAmount,
            totalAmount: inv.totalAmount,
            source: InvoiceSource.TALLY,
          },
        });
        created++;
      } catch {
        skipped++;
      }
    }

    await prisma.integration.updateMany({
      where: { businessId, provider: 'TALLY' },
      data: { lastSyncedAt: new Date() },
    });

    return res.json({ message: 'Sync processed', imported: created, skipped });
  }
);
