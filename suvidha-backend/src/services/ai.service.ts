import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

const SYSTEM_PROMPT = `
You are the compliance assistant inside Suvidha, a GST compliance tool for Indian small businesses.

Your job: explain reconciliation issues, GST concepts, and filing status in plain English -
the way a patient, knowledgeable friend would, not like a tax textbook.

Rules you must always follow:
- Only use the business data given to you in the CONTEXT section below. Never invent numbers,
  invoice details, or supplier names that aren't in that context.
- If the context doesn't contain enough information to answer, say so plainly and suggest what
  the person could check or upload instead of guessing.
- You explain and suggest - you never take actions. You cannot approve, submit, or file anything,
  and you cannot resolve a reconciliation issue on someone's behalf. Make this clear if anyone
  asks you to "just fix it" or "just file it".
- You are not a substitute for a qualified Chartered Accountant. For anything with real legal or
  financial stakes (how to respond to an official notice, an unusual transaction, anything
  you're not confident about), say so and recommend they confirm with their CA.
- Keep answers short and concrete. Lead with the actual number or fact, then explain why it
  matters, then suggest a next step if one applies.
`.trim();

interface BuildContextOptions {
  businessId: string;
  focusInvoiceId?: string;
}

/**
 * Gathers a snapshot of real, current data for this business - the same
 * numbers a human would see on the dashboard - so the model's answers are
 * grounded in what's actually true right now, not generic GST knowledge alone.
 */
async function buildBusinessContext({ businessId, focusInvoiceId }: BuildContextOptions): Promise<string> {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) return 'No business data available.';

  const unresolvedIssues = await prisma.reconciliationResult.findMany({
    where: { businessId, resolved: false },
    include: { invoice: true, gstReturnEntry: true },
    take: 20, // keep the context focused - the model doesn't need every historical issue
  });

  const latestFilings = await prisma.filing.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    take: 4,
  });

  let focusSection = '';
  if (focusInvoiceId) {
    const focusResult = await prisma.reconciliationResult.findFirst({
      where: { businessId, invoiceId: focusInvoiceId },
      include: { invoice: true, gstReturnEntry: true },
    });
    if (focusResult) {
      focusSection = `\nTHE PERSON IS SPECIFICALLY ASKING ABOUT THIS ISSUE:\n${JSON.stringify(focusResult, null, 2)}\n`;
    }
  }

  return `
BUSINESS: ${business.businessName} (GSTIN ${business.gstin})
FILING FREQUENCY: ${business.filingFrequency}
COMPLIANCE HEALTH SCORE: ${business.complianceHealthScore}/100

UNRESOLVED RECONCILIATION ISSUES (${unresolvedIssues.length} shown, most recent first):
${unresolvedIssues
  .map(
    (r) =>
      `- [${r.status}] invoice ${r.invoice?.invoiceNumber ?? '(none)'} · supplier ${
        r.invoice?.supplierOrCustomerName ?? r.gstReturnEntry?.supplierGstin ?? 'unknown'
      } · books: ₹${r.invoice?.totalAmount ?? 'n/a'} · government return: ₹${
        r.gstReturnEntry?.reportedTaxableValue ?? 'n/a'
      }${r.differenceAmount ? ` · difference: ₹${r.differenceAmount}` : ''}`
  )
  .join('\n') || 'None currently.'}

RECENT FILINGS:
${latestFilings
  .map((f) => `- ${f.returnType} for ${f.period}: ${f.status}, due ${f.dueDate.toISOString().slice(0, 10)}`)
  .join('\n') || 'None yet.'}
${focusSection}
`.trim();
}

/**
 * Sends a user message in an existing conversation, gets the assistant's
 * reply, and stores both. The whole conversation history is replayed each
 * time (standard for the Anthropic API - it has no memory between calls),
 * with fresh business context prepended so numbers are never stale.
 */
export async function sendMessage(
  conversationId: string,
  businessId: string,
  userContent: string,
  focusInvoiceId?: string
) {
  const conversation = await prisma.aiConversation.findUnique({
    where: { id: conversationId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!conversation) {
    throw new Error('Conversation not found');
  }

  await prisma.aiMessage.create({
    data: { conversationId, role: 'USER', content: userContent, relatedInvoiceId: focusInvoiceId },
  });

  const context = await buildBusinessContext({ businessId, focusInvoiceId });

  const history = conversation.messages.map((m) => ({
    role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
    content: m.content,
  }));

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: `${SYSTEM_PROMPT}\n\nCONTEXT:\n${context}`,
    messages: [...history, { role: 'user', content: userContent }],
  });

  const replyText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  const assistantMessage = await prisma.aiMessage.create({
    data: { conversationId, role: 'ASSISTANT', content: replyText, relatedInvoiceId: focusInvoiceId },
  });

  return assistantMessage;
}
