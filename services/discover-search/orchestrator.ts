// =============================================================================
// Discover Search Orchestrator
//
// Runs the three external search lanes in parallel, merges with the local
// catalog, dedupes, and calls the ranker to pick the top N with reasoning.
// Handles partial source failures gracefully — one source returning no data
// or errors never aborts the others.
// =============================================================================

import { listAllDiscoverItems } from '../discover-registry';
import type { DiscoverItem, DiscoverItemType } from '../discover-catalog';
import { getCustomDiscoverItem } from '../discover-store';
import {
  searchGitHubTopics,
  searchMcpServersOrg,
  searchSkillsSh,
  enrichCandidates,
  type SearchCandidate,
} from './external-search';
import { rankCandidates } from './ranker';

export interface SearchResult {
  candidate: SearchCandidate;
  /** True if this item is NOT already in custom_discover_items (user can save it). */
  isNew: boolean;
}

export interface SearchSummary {
  results: SearchResult[];
  totalCandidates: number;
  bySource: Record<string, number>;
  durationMs: number;
  warnings: string[];
}

/**
 * Run a full search pass. Always queries the local catalog; external sources
 * are best-effort — any failure is reported in `warnings` but doesn't abort.
 */
export async function searchDiscover(
  type: DiscoverItemType,
  description: string
): Promise<SearchSummary> {
  const startedAt = Date.now();
  const warnings: string[] = [];

  // ─── Lane 1: local catalog (always runs, instant) ─────────────────────
  const localCandidates = searchLocalCatalog(type, description);

  // ─── Lanes 2-4: external sources (parallel, best-effort) ──────────────
  const [githubResults, mcpServersResults, skillsShResults] = await Promise.all([
    searchGitHubTopics(type, description).catch((err) => {
      warnings.push(`github-topic: ${err instanceof Error ? err.message : String(err)}`);
      return [] as SearchCandidate[];
    }),
    searchMcpServersOrg(type, description).catch((err) => {
      warnings.push(`mcpservers-org: ${err instanceof Error ? err.message : String(err)}`);
      return [] as SearchCandidate[];
    }),
    searchSkillsSh(type, description).catch((err) => {
      warnings.push(`skills-sh: ${err instanceof Error ? err.message : String(err)}`);
      return [] as SearchCandidate[];
    }),
  ]);

  // ─── Dedupe by repoFullName (sitemap sources often overlap with GitHub) ──
  const merged = dedupeCandidates([
    ...localCandidates,
    ...githubResults,
    ...mcpServersResults,
    ...skillsShResults,
  ]);

  const bySource: Record<string, number> = {};
  for (const c of merged) {
    bySource[c.source] = (bySource[c.source] ?? 0) + 1;
  }

  // ─── Enrich sitemap hits with GitHub metadata (parallel, capped) ──────
  await enrichCandidates(merged, 12).catch((err) => {
    warnings.push(`enrichment: ${err instanceof Error ? err.message : String(err)}`);
  });

  // ─── Rank with Claude ─────────────────────────────────────────────────
  let ranked: SearchCandidate[] = [];
  try {
    ranked = await rankCandidates(description, merged);
  } catch (err) {
    warnings.push(`ranker: ${err instanceof Error ? err.message : String(err)}`);
    // Fallback: return the top 10 local candidates unranked so the user still
    // sees something rather than an empty list.
    ranked = merged
      .filter((c) => c.source === 'local')
      .slice(0, 10)
      .map((c) => ({
        ...c,
        score: 0.5,
        reasoning: 'Ranker unavailable — showing local catalog matches by keyword.',
      }));
  }

  // ─── Mark "isNew" based on whether the id already exists ──────────────
  const results: SearchResult[] = ranked.map((candidate) => ({
    candidate,
    isNew: candidate.source !== 'local' && !getCustomDiscoverItem(candidate.id),
  }));

  return {
    results,
    totalCandidates: merged.length,
    bySource,
    durationMs: Date.now() - startedAt,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Local catalog search — keyword match on name + description + tags
// -----------------------------------------------------------------------------

function searchLocalCatalog(
  type: DiscoverItemType,
  description: string
): SearchCandidate[] {
  const needle = description.toLowerCase();
  const tokens = needle.split(/\s+/).filter((t) => t.length >= 3);

  return listAllDiscoverItems()
    .filter((item) => item.type === type)
    .filter((item) => {
      if (tokens.length === 0) return true;
      const haystack = [
        item.name,
        item.description,
        item.longDescription ?? '',
        item.tags.join(' '),
        ...(item.capabilities ?? []),
      ]
        .join(' ')
        .toLowerCase();
      return tokens.some((tok) => haystack.includes(tok));
    })
    .slice(0, 30) // Don't overwhelm the ranker — top 30 local candidates is plenty
    .map((item: DiscoverItem) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      description: item.description,
      source: 'local' as const,
      sourceUrl: item.sourceUrl,
      author: item.author,
      tags: item.tags,
    }));
}

// -----------------------------------------------------------------------------
// Deduplication — collapse multi-source hits for the same GitHub repo
// -----------------------------------------------------------------------------

/**
 * Two candidates are considered duplicates if they share the same repoFullName
 * OR the same sourceUrl. Local catalog entries win over external hits because
 * they already have enriched metadata.
 */
function dedupeCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
  const bySignature = new Map<string, SearchCandidate>();
  const sourcePreference: Record<SearchCandidate['source'], number> = {
    'local': 4,
    'github-topic': 3,
    'mcpservers-org': 2,
    'skills-sh': 1,
  };

  for (const c of candidates) {
    const signature = (c.repoFullName ?? c.sourceUrl ?? c.id).toLowerCase();
    const existing = bySignature.get(signature);
    if (!existing) {
      bySignature.set(signature, c);
      continue;
    }
    // Keep the higher-preference source when there's a tie
    if (sourcePreference[c.source] > sourcePreference[existing.source]) {
      bySignature.set(signature, c);
    }
  }
  return Array.from(bySignature.values());
}
