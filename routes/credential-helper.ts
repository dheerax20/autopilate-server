// =============================================================================
// Credential Helper — chat-style assistant that tells the user exactly what
// to paste into a credential field on the Configure Wizard.
//
// The Configure Wizard already knows what's missing (each yellow card carries
// a `requirement` describing the gap). This route turns that requirement plus
// the provider catalog into a stream of plain-language guidance:
//   - which key/token is needed
//   - where to obtain it (signup URL + steps)
//   - what format to expect ("starts with sk-...", "32 hex chars", etc.)
//   - any free-tier or scoping notes
//
// Streamed as Server-Sent Events so the UI can render incrementally — same
// pattern as POST /api/configure-node.
// =============================================================================

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { validateBody } from '../src/middleware/validation';
import { getProviderAny } from '../services/provider-registry';

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const helperBodySchema = z.object({
  // The yellow-card requirement copy from the Configure Wizard.
  requirement: z.object({
    description: z.string().min(1),
    solution: z.string().optional(),
    nodeLabel: z.string().optional(),
    envVarName: z.string().optional(),
  }),
  // Optional — when the requirement maps to a known provider in the catalog,
  // pass the id so we can include canonical signup steps.
  providerId: z.string().optional(),
  // Optional follow-up turn from the user.
  userMessage: z.string().max(2000).optional(),
});

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

const router = Router();

router.post('/explain', validateBody(helperBodySchema), async (req: Request, res: Response) => {
  const { requirement, providerId, userMessage } = req.body as z.infer<typeof helperBodySchema>;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured', code: 'NO_AI_KEY' });
    return;
  }

  // Resolve provider context if available
  const provider = providerId ? getProviderAny(providerId) : undefined;
  const providerContext = provider
    ? {
        id: provider.id,
        name: provider.name,
        category: provider.category,
        description: provider.description,
        credentialType: provider.credentialType,
        fields: provider.fields,
        signupUrl: provider.signupUrl,
        signupSteps: provider.signupSteps,
        freeTier: provider.freeTier,
        docsUrl: provider.docsUrl,
        capabilities: provider.capabilities,
      }
    : null;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, payload: unknown): void => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const system = [
    'You are a friendly credential setup assistant for AUTOPILATE.',
    'A user is staring at a workflow node that needs an API key, OAuth token, or other credential.',
    'Your job: tell them exactly what to paste, where to get it, and how to verify it.',
    'Be concise — 3 to 6 short sentences or bullets. No fluff.',
    'If a signup URL is provided, link to it. If signup steps are provided, list them as numbered steps.',
    'If the field expects a specific format (sk-..., hex, JSON), say so explicitly.',
    'Never invent credentials, secrets, or example tokens that look real.',
    'If the user asks a follow-up, answer it directly without restarting the explanation.',
  ].join(' ');

  const userPrompt = [
    `## Workflow context`,
    requirement.nodeLabel ? `Node: ${requirement.nodeLabel}` : null,
    requirement.envVarName ? `Env var: ${requirement.envVarName}` : null,
    ``,
    `## What's missing`,
    requirement.description,
    requirement.solution ? `\nProposed solution: ${requirement.solution}` : '',
    ``,
    providerContext
      ? `## Provider catalog entry\n\`\`\`json\n${JSON.stringify(providerContext, null, 2)}\n\`\`\``
      : `## Provider catalog\nNo catalog entry matched this requirement — explain in general terms what kind of value belongs here based on the env var name and description.`,
    ``,
    userMessage ? `## User follow-up\n${userMessage}` : `## User follow-up\n(none — give your initial explanation)`,
  ]
    .filter(Boolean)
    .join('\n');

  const client = new Anthropic({ apiKey });

  try {
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      temperature: 0.3,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    });

    stream.on('text', (text) => {
      send('chunk', { text });
    });

    const final = await stream.finalMessage();
    const fullText = final.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    send('done', {
      text: fullText,
      provider: provider ? { id: provider.id, name: provider.name } : null,
      signupUrl: provider?.signupUrl ?? null,
    });
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    send('error', { message });
    res.end();
  }
});

export { router as credentialHelperRouter };
