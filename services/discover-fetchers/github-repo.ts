// =============================================================================
// GitHub Repo Fetcher
//
// Walks a path inside a GitHub repo, reads the README/SKILL file from each
// subdirectory, parses out the title + description, and emits DiscoverItem
// records ready for upsert into the marketplace.
//
// Auth: uses GITHUB_TOKEN if present (5000 req/hr), otherwise unauthenticated
// (60 req/hr — fine for our V1 sources which need ~30 calls per sync). On 403
// rate-limit, surface the error so the user knows to add a token.
//
// Parsing strategy:
//   1. SKILL.md / README.md may have YAML frontmatter with `name:` and
//      `description:` fields — prefer those when present (Anthropic skills use
//      this format).
//   2. Otherwise fall back to first H1 as name, first non-empty paragraph as
//      description.
//   3. Tags are extracted from frontmatter `tags:` if present, otherwise
//      derived from the source's baseTags + the subdir name.
// =============================================================================

import type { DiscoverItem, DiscoverCategory } from '../discover-catalog';
import type { DiscoverSource } from './sources';

interface GitHubContentEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  download_url: string | null;
}

interface GitHubFileResponse {
  content: string; // base64
  encoding: string;
}

interface ParsedReadme {
  name: string;
  description: string;
  tags: string[];
}

const GITHUB_API = 'https://api.github.com';

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

async function ghGet<T>(path: string): Promise<T> {
  const url = `${GITHUB_API}${path}`;
  const response = await fetch(url, { headers: authHeaders() });
  if (response.status === 403) {
    const body = await response.text();
    throw new Error(
      `GitHub API rate-limited or forbidden (${response.status}). ` +
      `Set GITHUB_TOKEN in server/.env to lift the unauthenticated 60/hr limit. ` +
      `Body: ${body.slice(0, 200)}`
    );
  }
  if (!response.ok) {
    throw new Error(
      `GitHub API ${response.status} ${response.statusText} for ${url}`
    );
  }
  return response.json() as Promise<T>;
}

/** Decode a base64 file payload from the GitHub contents API. */
function decodeBase64(encoded: string): string {
  return Buffer.from(encoded.replace(/\s+/g, ''), 'base64').toString('utf-8');
}

/**
 * Fetch every item from a single source. Lists the path's subdirectories,
 * fetches each one's README, parses, and returns DiscoverItem[].
 */
export async function fetchSource(source: DiscoverSource): Promise<{
  items: DiscoverItem[];
  errors: string[];
}> {
  const errors: string[] = [];
  const items: DiscoverItem[] = [];

  // 1. List the path's subdirectories
  const dirContents = await ghGet<GitHubContentEntry[]>(
    `/repos/${source.owner}/${source.repo}/contents/${source.path}`
  );
  const subdirs = dirContents.filter((e) => e.type === 'dir');

  // 2. For each subdir, find and fetch its README
  for (const subdir of subdirs) {
    try {
      const subContents = await ghGet<GitHubContentEntry[]>(
        `/repos/${source.owner}/${source.repo}/contents/${subdir.path}`
      );
      const readmeEntry = source.readmeFiles
        .map((name) => subContents.find((e) => e.type === 'file' && e.name === name))
        .find((e) => e !== undefined);

      if (!readmeEntry) {
        errors.push(`${subdir.name}: no README found (looked for ${source.readmeFiles.join(', ')})`);
        continue;
      }

      const readmeFile = await ghGet<GitHubFileResponse>(
        `/repos/${source.owner}/${source.repo}/contents/${readmeEntry.path}`
      );
      const readmeText = decodeBase64(readmeFile.content);
      const parsed = parseReadme(readmeText, subdir.name);

      // Detect language for MCP install command override (Python = uvx, JS = npx)
      const hasPyproject = subContents.some((e) => e.name === 'pyproject.toml');
      const hasPackageJson = subContents.some((e) => e.name === 'package.json');
      const installCommand = applyInstallTemplate(source, subdir.name, {
        hasPyproject,
        hasPackageJson,
      });

      const item: DiscoverItem = {
        id: `${source.type}-${source.id}-${subdir.name}`,
        name: parsed.name || subdir.name,
        type: source.type,
        category: categorize(parsed.name, parsed.description, source.defaultCategory),
        description: parsed.description.slice(0, 280),
        longDescription: parsed.description.length > 280 ? parsed.description : undefined,
        installCommand,
        configSnippet: source.configTemplate?.replace(/\{name\}/g, subdir.name),
        sourceUrl: `https://github.com/${source.owner}/${source.repo}/tree/main/${subdir.path}`,
        author: source.author,
        tags: Array.from(new Set([...source.baseTags, ...parsed.tags])),
        provenance: 'federated',
      };
      items.push(item);
    } catch (err) {
      errors.push(`${subdir.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { items, errors };
}

/**
 * Parse a README/SKILL file. Tries YAML frontmatter first (Anthropic skill
 * format), then falls back to H1 + first paragraph (MCP server README format).
 */
function parseReadme(text: string, fallbackName: string): ParsedReadme {
  const frontmatter = extractYamlFrontmatter(text);
  if (frontmatter) {
    return {
      name: frontmatter.name || fallbackName,
      description: frontmatter.description || '',
      tags: frontmatter.tags || [],
    };
  }

  // Markdown fallback: first H1 + first paragraph
  const lines = text.split(/\r?\n/);
  let name = fallbackName;
  let description = '';
  let inDescription = false;

  for (const line of lines) {
    if (!name && line.startsWith('# ')) {
      name = line
        .replace(/^#\s+/, '')
        .replace(/\s+(MCP\s+)?Server$/i, '')
        .replace(/^([^:]+):\s*.*$/, '$1') // strip everything after a colon (e.g., "mcp-server-git: A git Manipulation Server" → "mcp-server-git")
        .replace(/^mcp-server-/i, '')      // strip mcp-server- prefix
        .trim();
    }
    if (line.startsWith('# ') && !inDescription) {
      // Found the H1 — start collecting description from the next non-blank lines
      inDescription = true;
      // Set name even if we already had one from fallback
      name = line
        .replace(/^#\s+/, '')
        .replace(/\s+(MCP\s+)?Server$/i, '')
        .replace(/^([^:]+):\s*.*$/, '$1') // strip everything after a colon (e.g., "mcp-server-git: A git Manipulation Server" → "mcp-server-git")
        .replace(/^mcp-server-/i, '')      // strip mcp-server- prefix
        .trim();
      continue;
    }
    if (inDescription && line.trim() === '' && description) {
      // Description is the first non-blank paragraph after the H1
      break;
    }
    if (inDescription && line.trim() !== '' && !line.startsWith('<!--') && !line.startsWith('>')) {
      description += (description ? ' ' : '') + line.trim();
    }
  }

  return {
    name: name || fallbackName,
    description: description || `${fallbackName} — see source for details.`,
    tags: [],
  };
}

/**
 * Minimal YAML frontmatter parser. Only handles flat key: value pairs, which
 * is what the Anthropic skills use. Doesn't try to be a real YAML parser.
 */
function extractYamlFrontmatter(text: string): {
  name?: string;
  description?: string;
  tags?: string[];
} | null {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = text.slice(3, end).trim();
  const result: { name?: string; description?: string; tags?: string[] } = {};
  // Split into logical lines, allowing values to wrap onto continuation lines
  const lines = block.split('\n');
  let currentKey: string | null = null;
  let currentValue: string[] = [];
  const flush = () => {
    if (!currentKey) return;
    const joined = currentValue.join(' ').trim();
    if (currentKey === 'name') result.name = joined;
    else if (currentKey === 'description') result.description = joined;
    else if (currentKey === 'tags') {
      // tags: [a, b, c] OR tags: a, b, c
      const stripped = joined.replace(/^\[|\]$/g, '');
      result.tags = stripped.split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    currentKey = null;
    currentValue = [];
  };
  for (const line of lines) {
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (match) {
      flush();
      currentKey = match[1];
      if (match[2]) currentValue.push(match[2]);
    } else if (currentKey) {
      // Continuation line
      currentValue.push(line.trim());
    }
  }
  flush();
  return result;
}

/**
 * Substitute {name} into the install template, with overrides for MCP servers
 * that we can detect by language (pyproject.toml = Python = uvx).
 */
function applyInstallTemplate(
  source: DiscoverSource,
  name: string,
  hints: { hasPyproject: boolean; hasPackageJson: boolean }
): string {
  // For the "Official MCP Servers" source, prefer the language-appropriate command
  if (source.id === 'mcp-official-python' && hints.hasPyproject) {
    return `uvx mcp-server-${name}`;
  }
  if (source.id === 'mcp-official-python' && hints.hasPackageJson) {
    return `npx -y @modelcontextprotocol/server-${name}`;
  }
  return source.installTemplate.replace(/\{name\}/g, name);
}

/**
 * Heuristic category picker. Falls back to the source's default if nothing
 * matches. Keep this list small — most miscategorizations are fine because
 * the user can fix them on the card later (or we re-sync with smarter rules).
 */
function categorize(
  name: string,
  description: string,
  fallback: DiscoverCategory
): DiscoverCategory {
  const haystack = `${name} ${description}`.toLowerCase();
  if (/\b(search|fetch|web|browse|crawl)\b/.test(haystack)) return 'web-search';
  if (/\b(scrape|puppeteer|browser|render)\b/.test(haystack)) return 'scraping';
  if (/\b(database|sql|postgres|sqlite|query)\b/.test(haystack)) return 'data';
  if (/\b(storage|s3|drive|filesystem|files?)\b/.test(haystack)) return 'storage';
  if (/\b(slack|chat|message|notify)\b/.test(haystack)) return 'communication';
  if (/\b(github|git|code|review|pr|repo)\b/.test(haystack)) return 'developer-tools';
  if (/\b(memory|knowledge|graph|recall)\b/.test(haystack)) return 'data';
  if (/\b(thinking|reasoning|plan|sequential)\b/.test(haystack)) return 'reasoning';
  if (/\b(research|analysis|paper|cite)\b/.test(haystack)) return 'research';
  if (/\b(content|writing|brand|voice|style|doc)\b/.test(haystack)) return 'content';
  if (/\b(pdf|docx|pptx|xlsx|excel|word|powerpoint)\b/.test(haystack)) return 'productivity';
  if (/\b(time|calendar|schedule|date)\b/.test(haystack)) return 'productivity';
  return fallback;
}
