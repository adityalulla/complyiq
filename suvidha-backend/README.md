# Suvidha Backend — Milestone 1

This is the first real, running piece of the backend: sign up, sign in, business
creation (the first onboarding step), and role-based permissions enforced at the
API level — not just hidden in the UI.

## What's included
- `POST /auth/signup`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`
- `GET /me` — current user + every business they belong to
- `POST /businesses` — create a business (GSTIN/PAN validated), creator becomes Owner
- `GET /businesses/:businessId` — view a business
- `PATCH /businesses/:businessId` — edit a business (Owner/Admin only)
- `GET /businesses/:businessId/users` — list the team (Owner/Admin only)
- `POST /businesses/:businessId/users/invite` — add an existing user to the business with a role
- `PATCH /businesses/:businessId/users/:userId/role` — change someone's role (Owner/Admin only)
- Every important action is written to `audit_logs`

## What's deliberately NOT in Milestone 1 yet
Invoices, reconciliation, filing, AI assistant, notifications — these come in
Milestones 2 onward, per the MVP roadmap document. Building auth and business
creation first means every later milestone has something real to attach to.

## Prerequisites
- Node.js 18 or newer
- A PostgreSQL database (local, or a free-tier hosted one like Supabase/Neon/Railway)

## Setup

1. **Install dependencies** (needs internet access, which this sandbox doesn't have —
   run this on your own machine):
   ```
   npm install
   ```

2. **Set up your environment variables:**
   ```
   cp .env.example .env
   ```
   Then edit `.env` and fill in:
   - `DATABASE_URL` — your real PostgreSQL connection string
   - `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` — any long random strings
     (e.g. run `openssl rand -hex 32` twice and paste the results in)

3. **Create the database tables:**
   ```
   npm run prisma:migrate
   ```
   This reads `prisma/schema.prisma` and creates the `users`, `businesses`,
   `business_users`, and `audit_logs` tables for you.

4. **Run it:**
   ```
   npm run dev
   ```
   You should see: `Suvidha backend (Milestone 1) running on http://localhost:4000`

## Trying it out

Sign up:
```
curl -X POST http://localhost:4000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"name":"Suresh Ramamurthy","email":"suresh@example.com","password":"password123"}'
```

This returns an `accessToken` — use it to create a business:
```
curl -X POST http://localhost:4000/businesses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "businessName": "Sundaram Textiles Pvt Ltd",
    "businessType": "PRIVATE_LIMITED",
    "gstin": "33AABCS1429B1ZP",
    "pan": "AABCS1429B",
    "filingFrequency": "MONTHLY"
  }'
```

Then check your profile:
```
curl http://localhost:4000/me -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```
You should see the business you just created, with your role as `OWNER`.

## Connecting the frontend prototype
The dashboard prototype we built earlier currently uses fake, hardcoded data.
The next real step is wiring its sign-up/sign-in screens and onboarding form to
call these actual endpoints instead of just toggling screens — happy to do
that next once this backend is confirmed working on your machine.

---

## Milestone 2 additions (invoices + Tally sync)

New in this update:
- `POST /businesses/:businessId/invoices/upload` — manual invoice upload (file + typed-in details)
- `GET /businesses/:businessId/invoices` — filterable, paginated invoice list
- `GET /businesses/:businessId/invoices/:id` — single invoice detail
- `POST /businesses/:businessId/integrations` — connect an integration (Tally, Zoho, etc.)
- `GET /businesses/:businessId/integrations` — list connection status
- `DELETE /businesses/:businessId/integrations/:id` — disconnect
- `POST /businesses/:businessId/integrations/tally/sync` — machine-to-machine endpoint the **local Tally sync agent** (separate project, see `suvidha-tally-agent/`) calls to push invoices in

**Since the database schema changed, re-run the migration:**
```
npm run prisma:migrate
```

### Why manual upload comes before automatic extraction
Right now, `/invoices/upload` takes the invoice's details as typed-in fields
alongside the file, rather than reading the PDF/image itself. Automatically
extracting fields from a scanned invoice (OCR + AI) is real, valuable work,
but shipping the manual version first means you can start testing the
reconciliation engine (Milestone 3) with real invoice data immediately,
instead of waiting for extraction accuracy to be tuned.

### Why Tally needed a separate small project
Tally has no cloud API — it only exposes a local interface on the same
machine or network it runs on. So a small standalone agent
(`suvidha-tally-agent/`) runs next to the client's Tally installation and
pushes data out to this backend, authenticated with a per-integration API key
instead of a normal user login. See that project's own README for setup and,
importantly, its honest limitations — the exact Tally XML format needs
testing against a real Tally instance, which wasn't possible to do here.

### File storage note
Manual invoice uploads currently save to a local `uploads/` folder on
whatever machine runs this backend. That's fine for testing, but before real
launch this needs to move to proper cloud object storage (S3 or equivalent),
per the architecture doc — local disk storage doesn't survive a server
restart or scale past one machine.

---

## Milestone 3 additions (the reconciliation engine)

This is the actual core value of the product — the moment a business owner
sees a real problem caught automatically.

New endpoints:
- `POST /businesses/:businessId/gst-return-entries/upload` — bulk-import what the
  government/suppliers reported (mock GSTR-2B data, until Milestone 5's real GSP pull)
- `GET /businesses/:businessId/gst-return-entries` — list imported return entries
- `POST /businesses/:businessId/reconciliation/run` — run a fresh reconciliation pass
- `GET /businesses/:businessId/reconciliation/results` — list flagged issues, filterable by status/resolved
- `GET /businesses/:businessId/reconciliation/results/:id` — full detail for one issue (powers the comparison drawer)
- `PATCH /businesses/:businessId/reconciliation/results/:id/resolve` — mark an issue resolved, with a note

**Re-run the migration again, since the schema changed:**
```
npm run prisma:migrate
```

### How the matching actually works (`src/services/reconciliation.service.ts`)
On each run:
1. Every purchase invoice in your books is matched against imported GST return
   entries by invoice number + supplier GSTIN (normalized - trimmed, uppercased,
   so "inv-001" and "INV-001" still match).
2. If no match exists → **missing in return** (supplier may not have filed yet).
3. If matched but the taxable value or GST amount differs by more than ₹1 →
   **amount mismatch**, with the difference recorded.
4. If matched and amounts line up but the GST rate doesn't, or isn't a valid
   rate (0%, 0.25%, 3%, 5%, 12%, 18%, 28%) → **wrong GST rate**.
5. Any return entry that never matched an invoice at all → **missing in books**.
6. Separately, invoices with the same supplier, amount, and date but different
   invoice numbers are flagged as a likely **duplicate**.

Re-running reconciliation replaces previous *unresolved* results but leaves
anything already marked resolved untouched — so a human's decision doesn't
get silently wiped out by the next sync.

### Honest limitations to know about
- The ₹1 mismatch threshold and the duplicate-detection signature (same
  supplier + amount + date) are reasonable starting rules, not tuned against
  real invoice data yet — expect to adjust these once real businesses use it,
  per the "what's genuinely hard here" note in the architecture doc.
- GST return entries are still manually imported (no real GSTR-2B pull yet) —
  that's Milestone 5, once a GSP partnership is in place.

---

## Milestone 4 additions (filing preparation)

New endpoints:
- `GET /businesses/:businessId/filings` — list past and upcoming filings
- `POST /businesses/:businessId/filings/:period/prepare` — auto-generate a GSTR-1 or GSTR-3B draft for a month (period like `2026-07`), body: `{ "returnType": "GSTR_1" }` or `"GSTR_3B"`
- `GET /businesses/:businessId/filings/:id` — full summary for the review screen
- `POST /businesses/:businessId/filings/:id/approve` — **Owner/Admin only** — the human approval gate
- `POST /businesses/:businessId/filings/:id/submit` — marks it filed, **Owner/Admin only**

**Re-run the migration again:**
```
npm run prisma:migrate
```

### How the draft numbers are computed (`src/services/filing.service.ts`)
- **GSTR-1** pulls all sales invoices in the given month and totals taxable
  value and output GST payable — straight from the books.
- **GSTR-3B** pulls purchase invoices in the month, sums up total ITC claimed,
  and separately calculates **ITC at risk** — the portion tied to invoices
  that still have an unresolved reconciliation issue (mismatch, wrong rate,
  duplicate, or missing in the supplier's return). Net tax payable = output
  tax minus total ITC claimed.
- Due dates use the standard monthly rule (GSTR-1 by the 11th, GSTR-3B by the
  20th of the following month). **Businesses on the QRMP quarterly scheme
  actually follow different, quarter-based due dates** — this simplified
  version is a reasonable MVP default, not the full rule; worth fixing before
  quarterly filers rely on it.
- Once a filing is approved or submitted, re-preparing it is blocked — the
  numbers behind a human's approval should never silently change afterward.

### Important: "submit" is not real yet
`POST /filings/:id/submit` does **not** send anything to the actual GST
portal. It marks the filing `FILED` with an obviously-fake ARN
(`MOCK-ARN-...`) so the workflow is fully testable end-to-end. Real
submission needs a licensed GSP/ASP partnership — that's Milestone 5. Until
then, the real value delivered is an accurate, ready-to-file summary a
business owner or accountant can file manually on the actual GST portal.

---

## Milestone 6 additions (AI compliance assistant)

This one is a real, working integration with Claude (Anthropic's API) —
not a mock. It genuinely calls a live model and needs a real API key to run.

New endpoints:
- `POST /businesses/:businessId/ai/conversations` — start a conversation
- `GET /businesses/:businessId/ai/conversations/:id` — full message history
- `POST /businesses/:businessId/ai/conversations/:id/messages` — send a message, get a real reply

**Re-run the migration again:**
```
npm run prisma:migrate
```

**You'll need an Anthropic API key** — get one at console.anthropic.com, then
set `ANTHROPIC_API_KEY` in your `.env`. This is a paid API (small per-message
cost) — there's no way around that for a real AI assistant.

### How it's grounded in real data (`src/services/ai.service.ts`)
Before every reply, the service builds a fresh snapshot of that business's
actual current state — unresolved reconciliation issues, recent filings,
compliance health score — and gives it to the model as context. The system
prompt explicitly tells the model to only use what's in that context and to
say so plainly if it doesn't have enough information, rather than guessing.

The frontend can also pass a `focusInvoiceId` when sending a message (e.g.
when someone clicks "Ask AI to explain" from the reconciliation drawer) so
the model answers about that *exact* issue instead of asking which one you mean.

### Guardrails built into the system prompt
- The assistant is told explicitly that it explains and suggests, but **never
  takes actions** — it cannot approve, submit, or resolve anything itself,
  even if asked to "just fix it." That stays true no matter what's asked of
  it, since there's no code path connecting the AI service to the
  approve/submit/resolve endpoints in the first place — it's advisory only,
  by construction, not just by instruction.
- It's told to recommend a real Chartered Accountant for anything with real
  legal or financial stakes, rather than presenting itself as sufficient on
  its own.

### Honest limitations to know about
- I have not been able to actually run this against the live Anthropic API in
  this sandbox (no internet access here) — the code is correct against the
  documented API shape, but you should test it end-to-end yourself once you
  have a real key.
- The context sent to the model currently shows at most the 20 most recent
  unresolved issues and 4 most recent filings — reasonable for now, but worth
  revisiting once a business has a long history.
- There's no cost/rate limiting on AI calls yet — worth adding before this is
  open to real users, since each message costs real money.

---

## Milestone 7 additions (notifications, remaining integrations, reports)

New endpoints:
- `GET /businesses/:businessId/notifications` — the logged-in user's own notifications
- `PATCH /businesses/:businessId/notifications/:id/read` — mark one as read
- `POST /businesses/:businessId/notifications/check-deadlines` — manually trigger the deadline check (see cron note below)
- `GET /businesses/:businessId/integrations/zoho/connect` — get the Zoho Books OAuth URL to redirect to
- `GET /businesses/integrations/zoho/callback` — Zoho redirects here after approval
- `GET /businesses/:businessId/integrations/quickbooks/connect` — same, for QuickBooks
- `GET /businesses/integrations/quickbooks/callback` — QuickBooks redirects here after approval
- `GET /businesses/:businessId/reports/:type` — generate a report (`monthly-gst`, `annual-compliance`, `vendor-mismatch`, `tax-liability`, `itc`)
- `GET /businesses/:businessId/reports/:type/export?format=pdf|excel|csv` — export any report

**Re-run the migration again:**
```
npm run prisma:migrate
```

### Notifications
Notification records are always created in the database (so they show up in
the in-app list), and dispatch is attempted through a swappable provider
interface (`src/services/notification.service.ts`) that currently just logs
instead of actually sending — safe for local development, and the only
sensible default in an environment with no internet access to test a real
provider against. Swap in SendGrid (email) and Twilio (SMS/WhatsApp) by
filling in the commented-out provider classes in that file — the rest of the
app doesn't need to change.

**Nothing runs on a schedule by itself.** `check-deadlines` needs to be
triggered somehow — either call it manually, wire up `node-cron` inside this
app, or point an external scheduler (a cron job, a cloud scheduler service)
at that endpoint once a day.

### Zoho Books & QuickBooks (real OAuth2, not mocked)
Both are genuine cloud services with real OAuth2 APIs, so connecting them is
a normal browser redirect + callback — unlike Tally/Busy, which need a local
agent. Tokens are encrypted at rest with AES-256-GCM
(`src/utils/tokenCrypto.ts`) before being stored.

**I have not been able to test either OAuth flow against Zoho's or Intuit's
real servers** — that needs a registered developer app on each platform plus
a live, publicly reachable redirect URL, neither of which is possible in this
sandbox. The endpoints and token exchange shape match each provider's
published documentation as of this build, but treat this as a strong
starting point to test against a real developer account, not a guarantee.

**Busy** remains unbuilt beyond a flagged comment in the code — it's in the
same situation as Tally (no cloud API for most versions), so the correct
approach is copying `suvidha-tally-agent/` as a template and adapting it,
rather than a from-scratch integration.

### Reports
All five report types compute directly from real data already in the
database (filings, reconciliation results, invoices) — nothing here is
placeholder data. Exports use `exceljs` for Excel and `pdfkit` for PDF, both
real, working libraries (not mocks) — though as with everything else in this
build, I haven't been able to run them end-to-end in this sandbox, so
generate a sample of each format yourself early on to confirm they look right.


## A few honest notes before you go further
- **Logout is currently client-side only.** Since refresh tokens are stateless
  JWTs, a real "invalidate this session everywhere" logout needs a stored
  token table — worth adding before real users depend on it.
- **Invites currently require the invited person to already have an account.**
  A proper "invite someone who hasn't signed up yet" email flow is a
  Milestone 2 addition.
- **Rate limiting and email verification** aren't in yet — needed before this
  is safe to expose on the public internet.
