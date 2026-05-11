// =============================================================================
// Inventory File Parsers
// =============================================================================

import fs from 'fs/promises';
import path from 'path';
import { ComponentInfo } from './types';

/**
 * Extract description from README.md (first paragraph after title)
 */
export async function parseReadme(readmePath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(readmePath, 'utf-8');
    // Skip title and badges, find first paragraph
    const lines = content.split('\n');
    let foundTitle = false;
    let description = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!foundTitle && trimmed.startsWith('#')) {
        foundTitle = true;
        continue;
      }
      if (foundTitle && trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('[') && !trimmed.startsWith('!')) {
        description = trimmed;
        break;
      }
    }

    return description || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract name and description from markdown frontmatter or first lines
 */
export async function parseComponentFile(filePath: string): Promise<{ name?: string; description?: string }> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');

    // Try to parse YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      const nameMatch = frontmatter.match(/^name:\s*['"]?(.+?)['"]?\s*$/m);
      const descMatch = frontmatter.match(/^description:\s*['"]?(.+?)['"]?\s*$/m);
      return {
        name: nameMatch?.[1]?.trim(),
        description: descMatch?.[1]?.trim(),
      };
    }

    // Fallback: Use first heading as name
    const headingMatch = content.match(/^#\s+(.+)$/m);
    return {
      name: headingMatch?.[1]?.trim(),
      description: undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Parse awesome-mcp-servers README to extract MCP server entries
 */
export async function parseAwesomeMcpList(readmePath: string): Promise<ComponentInfo[]> {
  const mcps: ComponentInfo[] = [];

  try {
    const content = await fs.readFile(readmePath, 'utf-8');
    // Match lines like: - [name](url) - description
    const pattern = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)[^-]*-\s*(.+)$/gm;
    let match;

    while ((match = pattern.exec(content)) !== null) {
      const [, name, url, description] = match;
      mcps.push({
        name: name.trim(),
        path: url.trim(),
        category: 'curated-list',
        description: description.trim().slice(0, 200),
        repo: 'awesome-mcp-servers',
      });
    }
  } catch {
    // File doesn't exist
  }

  return mcps;
}
