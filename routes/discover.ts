// =============================================================================
// Discover API Routes
//
// Browse the marketplace catalog of MCP servers, Claude skills, prompts, and
// agents. Read-only by default — the only write endpoint is the AI-assisted
// generator, which mirrors the credential vault's "Not listed?" pattern.
// =============================================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateBody } from '../src/middleware/validation';
import { AppError } from '../src/middleware/error-handler';
import { listAllDiscoverItems, getDiscoverItemAny } from '../services/discover-registry';
import {
  generateDiscoverItem,
  DiscoverGenerationError,
} from '../services/discover-generator';
import { syncAllSources } from '../services/discover-sync';
import { searchDiscover } from '../services/discover-search/orchestrator';
import {
  candidateToDiscoverItem,
  type SearchCandidate,
} from '../services/discover-search/external-search';
import { upsertCustomDiscoverItem } from '../services/discover-store';

const generateDiscoverSchema = z.object({
  description: z.string().min(1).max(2000),
  type: z
    .enum(['mcp', 'skill', 'prompt', 'agent', 'subagent', 'command', 'hook', 'plugin'])
    .optional(),
});

const searchDiscoverSchema = z.object({
  description: z.string().min(1).max(2000),
  type: z.enum(['mcp', 'skill', 'prompt', 'agent', 'subagent', 'command', 'hook', 'plugin']),
});

const saveSearchResultsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.enum(['mcp', 'skill', 'prompt', 'agent', 'subagent', 'command', 'hook', 'plugin']),
      description: z.string(),
      source: z.enum(['local', 'github-topic', 'mcpservers-org', 'skills-sh']),
      sourceUrl: z.string().optional(),
      author: z.string().optional(),
      tags: z.array(z.string()),
      repoFullName: z.string().optional(),
      score: z.number().optional(),
      reasoning: z.string().optional(),
    })
  ).min(1).max(20),
});

const router = Router();

/**
 * GET /api/discover
 *
 * Browse the merged catalog (hardcoded + AI-generated). Filters:
 *   - type        mcp | skill | prompt | agent
 *   - category    web-search | scraping | data | etc.
 *   - q           free-text search across name + description + tags
 */
router.get('/', (req: Request, res: Response) => {
  const { type, category, q } = req.query;
  let items = listAllDiscoverItems();

  if (typeof type === 'string') {
    items = items.filter((i) => i.type === type);
  }
  if (typeof category === 'string') {
    items = items.filter((i) => i.category === category);
  }
  if (typeof q === 'string' && q.trim()) {
    const needle = q.toLowerCase();
    items = items.filter((i) => {
      const haystack = [
        i.name,
        i.description,
        i.longDescription ?? '',
        i.tags.join(' '),
        i.author ?? '',
        ...(i.capabilities ?? []),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }

  res.json({ items });
});

/**
 * GET /api/discover/:id
 *
 * Fetch a single item — used by the detail drawer when the user clicks a card.
 */
router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = getDiscoverItemAny(req.params.id);
    if (!item) {
      throw new AppError(404, `Discover item "${req.params.id}" not found`, 'NOT_FOUND');
    }
    res.json(item);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/discover/generate
 *
 * AI-assisted item creation. Same UX pattern as the credential vault's
 * "Not listed? Describe it" flow — Claude generates a DiscoverItem, the
 * server validates + persists, and the picker sees the new entry on next
 * fetch.
 */
router.post(
  '/generate',
  validateBody(generateDiscoverSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { description, type } = req.body as {
        description: string;
        type?: 'mcp' | 'skill' | 'prompt' | 'agent' | 'subagent' | 'command' | 'hook' | 'plugin';
      };
      const result = await generateDiscoverItem(description, { typeHint: type });
      res.json({ item: result.item, warnings: result.warnings });
    } catch (error) {
      if (error instanceof DiscoverGenerationError) {
        return next(
          new AppError(422, error.message, 'DISCOVER_GENERATION_FAILED')
        );
      }
      next(error);
    }
  }
);

/**
 * POST /api/discover/search
 *
 * Live search across local + external sources with Claude relevance ranking.
 * Merges candidates from:
 *   - Local catalog (hardcoded + AI-generated + previously synced)
 *   - GitHub topic search (live)
 *   - mcpservers.org sitemap (cached 6h)
 *   - skills.sh sitemap (cached 6h)
 *
 * Returns top N ranked by Claude with per-item reasoning and an `isNew`
 * flag indicating whether the item would be new to the user's catalog.
 */
router.post(
  '/search',
  validateBody(searchDiscoverSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type, description } = req.body as {
        type: 'mcp' | 'skill' | 'prompt' | 'agent' | 'subagent' | 'command' | 'hook' | 'plugin';
        description: string;
      };
      const summary = await searchDiscover(type, description);
      res.json(summary);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/discover/save-results
 *
 * Persist selected search results into custom_discover_items so they show
 * up in the main marketplace browser alongside curated/federated items.
 * Called when the user ticks boxes in the search results drawer and clicks
 * "Save to catalog".
 */
router.post(
  '/save-results',
  validateBody(saveSearchResultsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { items } = req.body as { items: SearchCandidate[] };
      let saved = 0;
      const errors: string[] = [];
      for (const candidate of items) {
        try {
          const item = candidateToDiscoverItem(candidate);
          await upsertCustomDiscoverItem(item, `search:${candidate.source}`);
          saved++;
        } catch (err) {
          errors.push(`${candidate.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      res.json({ saved, errors });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/discover/sync
 *
 * Run an on-demand sync against every configured source (currently the
 * official MCP servers + Anthropic skills GitHub repos). Upserts every
 * discovered item into custom_discover_items and returns a per-source
 * summary. Triggered from the "Sync from sources" button on the Discover
 * dashboard. Synchronous — sync time is dominated by GitHub API calls
 * (~30 calls per source, sub-3-second total uncached).
 */
router.post('/sync', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await syncAllSources();
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

export { router as discoverRouter };
