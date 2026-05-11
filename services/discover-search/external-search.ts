// =============================================================================
// External Discover Search
//
// Live search across aggregator sources for candidate DiscoverItems that
// aren't yet in the local federated catalog. Three lanes run in parallel:
//
//   1. GitHub topic search — topic-filtered repo search (topic:mcp-server,
//      topic:claude-skills, etc.) tailored per DiscoverItemType. Live, well-
//      indexed, returns recent community work.
//
//   2. mcpservers.org sitemap — their sitemap indexes ~8000 MCP servers and
//      agent skills as /servers/<owner>/<repo> and /agent-skills/<owner>/<name>
//      URLs. We fetch the sitemap index once, cache the URL list, filter by
//      keyword, and resolve matches to GitHub repos.
//
//   3. skills.sh sitemap — same shape (owner/repo/skill triples), about 4000
//      skill URLs. Filtered by keyword, resolved to GitHub.
//
// Sources we deliberately skip:
//   - skillsmp.com — Cloudflare JS challenge blocks all automated access
//   - buildwithclaude.com — robots.txt explicitly disallows ClaudeBot/GPTBot
//   - skills.sh detail pages — SPA shells, data is hidden behind client-rendered
//     state (but the sitemap URLs ARE usable, which is what we leverage)
// =============================================================================

import type { DiscoverItem, DiscoverItemType } from '../discover-catalog';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SearchCandidate {
  /** Stable id across sources — typically "<sourceId>-<owner>-<repo>". */
  id: string;
  name: string;
  type: DiscoverItemType;
  description: string;
  /** Where this candidate came from — shown as a badge in the UI. */
  source: 'local' | 'github-topic' | 'mcpservers-org' | 'skills-sh';
  sourceUrl?: string;
  author?: string;
  tags: string[];
  /** GitHub repo full name (owner/repo) when resolvable. Used for metadata fetches. */
  repoFullName?: string;
  /** Relevance score (0-1) assigned by the ranker later. */
  score?: number;
  /** Claude's 1-2 sentence explanation of why this matches. Filled by the ranker. */
  reasoning?: string;
  /** True when this candidate matches an id already in custom_discover_items. */
  isNew?: boolean;
}

interface GitHubSearchRepo {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  owner: { login: string };
  topics: string[];
}

interface GitHubSearchResponse {
  total_count: number;
  items: GitHubSearchRepo[];
}

// -----------------------------------------------------------------------------
// Sitemap cache — fetched once per process, refreshed every 6 hours
// -----------------------------------------------------------------------------

interface SitemapCache {
  urls: string[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const mcpServersCache: SitemapCache = { urls: [], fetchedAt: 0 };
const skillsShCache: SitemapCache = { urls: [], fetchedAt: 0 };

function isCacheFresh(cache: SitemapCache): boolean {
  return cache.urls.length > 0 && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

// -----------------------------------------------------------------------------
// GitHub helpers
// -----------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'AUTOPILATE-Discover/1.0',
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function ghSearchRepos(query: string, perPage = 15): Promise<GitHubSearchRepo[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${perPage}&sort=stars&order=desc`;
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) {
    console.warn(`[discover-search] GitHub search failed: ${response.status} for ${query}`);
    return [];
  }
  const data = (await response.json()) as GitHubSearchResponse;
  return data.items ?? [];
}

/** Fetch repo metadata for a specific (owner, repo). Used when resolving sitemap hits. */
async function ghGetRepo(fullName: string): Promise<GitHubSearchRepo | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${fullName}`, {
      headers: authHeaders(),
    });
    if (!response.ok) return null;
    return (await response.json()) as GitHubSearchRepo;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Source 1: GitHub topic search
// -----------------------------------------------------------------------------

/**
 * Topic + keyword filters tailored per DiscoverItemType. Each type has a
 * couple of topics we know are well-populated, and we bolt the user's free-text
 * description onto the query as an AND filter so the results stay relevant.
 */
function topicsForType(type: DiscoverItemType): string[] {
  switch (type) {
    case 'mcp':
      return ['mcp-server', 'model-context-protocol', 'modelcontextprotocol'];
    case 'skill':
      return ['claude-skills', 'agent-skills', 'claude-skill'];
    case 'prompt':
      return ['claude-prompts', 'system-prompts', 'prompt-engineering'];
    case 'agent':
    case 'subagent':
      return ['ai-agent', 'claude-agents', 'agent-framework'];
    case 'command':
      return ['claude-commands', 'slash-commands'];
    case 'hook':
      return ['claude-hooks'];
    case 'plugin':
      return ['claude-plugin', 'claude-plugins'];
  }
}

export async function searchGitHubTopics(
  type: DiscoverItemType,
  keywords: string
): Promise<SearchCandidate[]> {
  const topics = topicsForType(type);
  // Fire one query per topic, each with the user's keywords. Union the results.
  const perTopicResults = await Promise.all(
    topics.map((topic) =>
      ghSearchRepos(`topic:${topic} ${keywords}`.trim(), 10).catch(() => [] as GitHubSearchRepo[])
    )
  );

  const seen = new Set<string>();
  const candidates: SearchCandidate[] = [];
  for (const repos of perTopicResults) {
    for (const repo of repos) {
      if (seen.has(repo.full_name)) continue;
      seen.add(repo.full_name);
      candidates.push({
        id: `github-topic-${type}-${repo.full_name.replace('/', '-').toLowerCase()}`,
        name: repo.name,
        type,
        description: repo.description ?? '',
        source: 'github-topic',
        sourceUrl: repo.html_url,
        author: repo.owner.login,
        tags: [...(repo.topics ?? []).slice(0, 5), 'github-search'],
        repoFullName: repo.full_name,
      });
    }
  }
  return candidates;
}

// -----------------------------------------------------------------------------
// Source 2: mcpservers.org sitemap
// -----------------------------------------------------------------------------

/**
 * Fetch the mcpservers.org sitemap index, load all referenced sub-sitemaps,
 * and return a flat list of indexed URLs. Cached for 6 hours so subsequent
 * searches don't re-fetch the ~8000 URL list.
 */
async function loadMcpServersSitemap(): Promise<string[]> {
  if (isCacheFresh(mcpServersCache)) return mcpServersCache.urls;

  const indexResp = await fetch('https://mcpservers.org/sitemap.xml', {
    headers: { 'User-Agent': 'AUTOPILATE-Discover/1.0' },
  });
  if (!indexResp.ok) {
    console.warn(`[discover-search] mcpservers sitemap index failed: ${indexResp.status}`);
    return [];
  }
  const indexXml = await indexResp.text();
  const subSitemapMatches = indexXml.matchAll(/<loc>([^<]+)<\/loc>/g);
  const subSitemapUrls = Array.from(subSitemapMatches, (m) => m[1]);

  const allUrls: string[] = [];
  for (const subUrl of subSitemapUrls) {
    try {
      const resp = await fetch(subUrl, { headers: { 'User-Agent': 'AUTOPILATE-Discover/1.0' } });
      if (!resp.ok) continue;
      const xml = await resp.text();
      const locMatches = xml.matchAll(/<loc>([^<]+)<\/loc>/g);
      for (const m of locMatches) allUrls.push(m[1]);
    } catch {
      // Ignore individual sub-sitemap failures
    }
  }

  mcpServersCache.urls = allUrls;
  mcpServersCache.fetchedAt = Date.now();
  console.log(`[discover-search] mcpservers.org: cached ${allUrls.length} URLs`);
  return allUrls;
}

/**
 * Search the mcpservers.org sitemap for URLs matching the keywords + type.
 * Filters URLs by type (/servers/ for mcp, /agent-skills/ for skill), then by
 * keyword substring match on the path. Only resolves the top N to GitHub
 * metadata to keep latency bounded.
 */
export async function searchMcpServersOrg(
  type: DiscoverItemType,
  keywords: string
): Promise<SearchCandidate[]> {
  if (type !== 'mcp' && type !== 'skill') return []; // Only these two types are indexed
  const urls = await loadMcpServersSitemap();
  if (urls.length === 0) return [];

  const pathPrefix = type === 'mcp' ? '/servers/' : '/agent-skills/';
  const needle = keywords.toLowerCase().trim();
  const needleTokens = needle.split(/\s+/).filter((t) => t.length >= 3);

  // Filter to type-specific URLs that contain any keyword token in the path
  const hits = urls.filter((url) => {
    if (!url.includes(pathPrefix)) return false;
    const path = url.toLowerCase();
    return needleTokens.length === 0
      ? true
      : needleTokens.some((tok) => path.includes(tok));
  });

  // Parse owner/repo/slug from URL, build minimal candidates
  const candidates: SearchCandidate[] = [];
  for (const url of hits.slice(0, 30)) {
    const parts = url.replace('https://mcpservers.org', '').split('/').filter(Boolean);
    // /servers/<owner>/<repo>  or  /agent-skills/<owner>/<name>
    if (parts.length < 3) continue;
    const [, owner, name] = parts;
    const repoFullName = `${owner}/${name}`;
    candidates.push({
      id: `mcpservers-${type}-${owner}-${name}`.toLowerCase(),
      name,
      type,
      description: '',
      source: 'mcpservers-org',
      sourceUrl: url,
      author: owner,
      tags: ['mcpservers.org', type],
      repoFullName,
    });
  }
  return candidates;
}

// -----------------------------------------------------------------------------
// Source 3: skills.sh sitemap
// -----------------------------------------------------------------------------

async function loadSkillsShSitemap(): Promise<string[]> {
  if (isCacheFresh(skillsShCache)) return skillsShCache.urls;
  const response = await fetch('https://skills.sh/sitemap.xml', {
    headers: { 'User-Agent': 'AUTOPILATE-Discover/1.0' },
  });
  if (!response.ok) {
    console.warn(`[discover-search] skills.sh sitemap failed: ${response.status}`);
    return [];
  }
  const xml = await response.text();
  const urls = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g), (m) => m[1]);
  skillsShCache.urls = urls;
  skillsShCache.fetchedAt = Date.now();
  console.log(`[discover-search] skills.sh: cached ${urls.length} URLs`);
  return urls;
}

export async function searchSkillsSh(
  type: DiscoverItemType,
  keywords: string
): Promise<SearchCandidate[]> {
  if (type !== 'skill') return []; // skills.sh only indexes skills
  const urls = await loadSkillsShSitemap();
  if (urls.length === 0) return [];

  const needle = keywords.toLowerCase().trim();
  const needleTokens = needle.split(/\s+/).filter((t) => t.length >= 3);

  const hits = urls.filter((url) => {
    const path = url.toLowerCase();
    return needleTokens.length === 0
      ? true
      : needleTokens.some((tok) => path.includes(tok));
  });

  const candidates: SearchCandidate[] = [];
  for (const url of hits.slice(0, 20)) {
    const parts = url.replace('https://skills.sh/', '').split('/').filter(Boolean);
    // <owner>/<repo>/<skill-name>
    if (parts.length < 3) continue;
    const [owner, repo, skillName] = parts;
    candidates.push({
      id: `skills-sh-${owner}-${repo}-${skillName}`.toLowerCase(),
      name: skillName,
      type: 'skill',
      description: `Skill from ${owner}/${repo}`,
      source: 'skills-sh',
      sourceUrl: url,
      author: owner,
      tags: ['skills.sh', 'skill'],
      repoFullName: `${owner}/${repo}`,
    });
  }
  return candidates;
}

// -----------------------------------------------------------------------------
// Candidate enrichment — fetch GitHub metadata for mcpservers/skills.sh hits
// -----------------------------------------------------------------------------

/**
 * For candidates missing a description (sitemap-sourced), fetch the GitHub
 * repo metadata to populate name/description/tags. Runs in parallel with a
 * cap so we don't burn the whole rate limit on one search.
 */
export async function enrichCandidates(
  candidates: SearchCandidate[],
  maxEnrich = 12
): Promise<void> {
  const needsEnrichment = candidates
    .filter((c) => !c.description && c.repoFullName)
    .slice(0, maxEnrich);

  await Promise.all(
    needsEnrichment.map(async (c) => {
      if (!c.repoFullName) return;
      const repo = await ghGetRepo(c.repoFullName);
      if (!repo) return;
      c.description = repo.description ?? c.description;
      if (repo.topics?.length) {
        c.tags = Array.from(new Set([...c.tags, ...repo.topics.slice(0, 3)]));
      }
    })
  );
}

// -----------------------------------------------------------------------------
// Convert candidate → DiscoverItem for persistence
// -----------------------------------------------------------------------------

/**
 * Build a DiscoverItem from an enriched candidate so it can be upserted into
 * custom_discover_items (when the user chooses to save a search result).
 * Mirrors the shape produced by the github-repo fetcher for consistency.
 */
export function candidateToDiscoverItem(c: SearchCandidate): DiscoverItem {
  // Pick a reasonable install command template per type
  let installCommand = `See source: ${c.sourceUrl ?? 'https://github.com'}`;
  if (c.type === 'mcp' && c.repoFullName) {
    // Most community MCPs use npx or uvx — user will need to verify
    installCommand = `npx -y ${c.repoFullName.split('/')[1]}`;
  } else if (c.type === 'skill' && c.repoFullName) {
    installCommand = `Clone https://github.com/${c.repoFullName} and copy the skill directory into .claude/skills/`;
  }

  return {
    id: c.id,
    name: c.name,
    type: c.type,
    category: 'other',
    description: c.description || `${c.name} — sourced from ${c.source}`,
    installCommand,
    sourceUrl: c.sourceUrl,
    author: c.author,
    tags: c.tags,
    // Everything Search surfaces comes from real repos or sitemaps that point
    // at real repos — federate trust level, not AI-generated.
    provenance: 'federated',
  };
}
