// =============================================================================
// Inventory Directory Scanners
// =============================================================================

import fs from 'fs/promises';
import path from 'path';
import {
  ComponentInfo,
  InventoryItem,
  BundleData,
  NestedMcpConfig,
} from './types';
import {
  INVENTORY_ROOT,
  REPO_CONFIGS,
  NESTED_MCP_CONFIGS,
  TYPE_TO_NODE_TYPE,
} from './config';
import { parseReadme, parseComponentFile, parseAwesomeMcpList } from './parsers';
import { getCachedInventory, setCachedInventory } from './cache';

/**
 * Scan a directory where each subdirectory is an MCP server
 */
async function scanMcpDirectory(
  dirPath: string,
  repoName: string
): Promise<ComponentInfo[]> {
  const mcps: ComponentInfo[] = [];

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue; // Skip hidden folders

      const mcpPath = path.join(dirPath, entry.name);
      const readmePath = path.join(mcpPath, 'README.md');

      // Try to get description from README
      const description = await parseReadme(readmePath);

      // Clean up name (remove -main, -master suffix)
      let name = entry.name
        .replace(/-main$/, '')
        .replace(/-master$/, '');

      mcps.push({
        name,
        path: mcpPath,
        category: 'mcp-servers',
        description,
        repo: repoName,
      });
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return mcps;
}

/**
 * Scan nested MCP structures within repos
 */
async function scanNestedMcps(
  config: NestedMcpConfig,
  basePath: string
): Promise<ComponentInfo[]> {
  const mcps: ComponentInfo[] = [];
  const fullPath = config.subPath
    ? path.join(basePath, config.repoName, config.subPath)
    : path.join(basePath, config.repoName);

  try {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      // Apply pattern filter if specified
      if (config.pattern && !config.pattern.test(entry.name)) continue;

      const mcpPath = path.join(fullPath, entry.name);
      const readmePath = path.join(mcpPath, config.descriptionFile || 'README.md');

      const description = await parseReadme(readmePath);

      mcps.push({
        name: entry.name,
        path: mcpPath,
        category: config.category,
        description,
        repo: config.repoName.replace(/-main$/, '').replace(/-master$/, ''),
      });
    }
  } catch {
    // Directory doesn't exist
  }

  return mcps;
}

/**
 * Scan a directory for component files (.md, .json)
 */
async function scanComponentDir(
  dirPath: string,
  componentType: string,
  repoName: string,
  categoryOverride?: string
): Promise<ComponentInfo[]> {
  const components: ComponentInfo[] = [];

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Recurse into subdirectory (category folder)
        const subComponents = await scanComponentDir(
          entryPath,
          componentType,
          repoName,
          categoryOverride || entry.name
        );
        components.push(...subComponents);
      } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.json'))) {
        // Skip README files
        if (entry.name.toLowerCase() === 'readme.md') continue;

        const parsed = await parseComponentFile(entryPath);
        const baseName = path.basename(entry.name, path.extname(entry.name));

        components.push({
          name: parsed.name || baseName,
          path: entryPath,
          category: categoryOverride || 'uncategorized',
          description: parsed.description,
          repo: repoName,
        });
      }
    }
  } catch {
    // Directory doesn't exist or can't be read - silently skip
  }

  return components;
}

/**
 * Scan plugin bundles from claude-code-main/plugins/
 * Each plugin directory can contain agents/, commands/, skills/, hooks/ subdirectories
 */
async function scanPluginBundles(): Promise<InventoryItem[]> {
  const bundles: InventoryItem[] = [];
  const pluginsPath = path.join(INVENTORY_ROOT, 'claude-code-main/plugins');

  try {
    const entries = await fs.readdir(pluginsPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      const pluginPath = path.join(pluginsPath, entry.name);

      // Read plugin description from README.md or plugin.json
      const readmePath = path.join(pluginPath, 'README.md');
      const pluginJsonPath = path.join(pluginPath, '.claude-plugin/plugin.json');

      let description: string | undefined;

      // Try plugin.json first
      try {
        const pluginJson = JSON.parse(await fs.readFile(pluginJsonPath, 'utf-8'));
        description = pluginJson.description;
      } catch {
        // Fall back to README
        description = await parseReadme(readmePath);
      }

      // Scan for component subdirectories
      const components: BundleData['components'] = {
        agents: [],
        commands: [],
        skills: [],
        hooks: [],
      };

      const componentTypes = ['agents', 'commands', 'skills', 'hooks'] as const;

      for (const compType of componentTypes) {
        const compPath = path.join(pluginPath, compType);

        try {
          const compEntries = await fs.readdir(compPath, { withFileTypes: true });

          for (const compEntry of compEntries) {
            if (!compEntry.isFile()) continue;
            if (!compEntry.name.endsWith('.md') && !compEntry.name.endsWith('.json')) continue;
            if (compEntry.name.toLowerCase() === 'readme.md') continue;

            const filePath = path.join(compPath, compEntry.name);
            const parsed = await parseComponentFile(filePath);
            const baseName = path.basename(compEntry.name, path.extname(compEntry.name));

            components[compType].push({
              name: parsed.name || baseName,
              path: filePath,
              category: compType,
              description: parsed.description,
            });
          }
        } catch {
          // Directory doesn't exist - skip
        }
      }

      // Calculate total count
      const totalCount =
        components.agents.length +
        components.commands.length +
        components.skills.length +
        components.hooks.length;

      // Only include if plugin has at least one component
      if (totalCount > 0) {
        bundles.push({
          id: `bundle/${entry.name}`,
          name: entry.name,
          path: pluginPath,
          type: 'bundle',
          description,
          repo: 'claude-code-main',
          bundleData: {
            description,
            components,
            totalCount,
          },
        });
      }
    }
  } catch {
    // Plugins directory doesn't exist
  }

  // Sort bundles alphabetically
  bundles.sort((a, b) => a.name.localeCompare(b.name));

  return bundles;
}

/**
 * Scan all configured repos and build the full inventory tree.
 * Results are cached with a configurable TTL (default 5 min, env INVENTORY_CACHE_TTL_MS).
 * Subsequent calls within the TTL window return the cached result without hitting the filesystem.
 */
export const scanInventory = async (): Promise<InventoryItem[]> => {
  const cached = getCachedInventory();
  if (cached) return cached;

  const result = await scanInventoryUncached();
  setCachedInventory(result);
  return result;
};

/** The actual filesystem scan — always runs, no cache. */
async function scanInventoryUncached(): Promise<InventoryItem[]> {
  // Map: type -> repo -> category -> components
  const typeMap = new Map<string, Map<string, Map<string, ComponentInfo[]>>>();

  // Helper to add MCPs to the type map
  const addMcpsToMap = (mcps: ComponentInfo[]) => {
    for (const mcp of mcps) {
      if (!typeMap.has('mcps')) {
        typeMap.set('mcps', new Map());
      }
      const repoMap = typeMap.get('mcps')!;

      if (!repoMap.has(mcp.repo)) {
        repoMap.set(mcp.repo, new Map());
      }
      const categoryMap = repoMap.get(mcp.repo)!;

      if (!categoryMap.has(mcp.category)) {
        categoryMap.set(mcp.category, []);
      }
      categoryMap.get(mcp.category)!.push(mcp);
    }
  };

  // 1. Scan top-level MCP directories (1.MCP-MISC root repos)
  const mcpMiscPath = path.join(INVENTORY_ROOT, '1.MCP-MISC');
  const topLevelMcps = await scanMcpDirectory(mcpMiscPath, '1.MCP-MISC');
  addMcpsToMap(topLevelMcps);

  // 2. Scan nested MCP structures (subfolders within repos)
  for (const config of NESTED_MCP_CONFIGS) {
    const nestedMcps = await scanNestedMcps(config, path.join(INVENTORY_ROOT, '1.MCP-MISC'));
    addMcpsToMap(nestedMcps);
  }

  // 3. Parse awesome-mcp-servers curated list
  const awesomePath = path.join(INVENTORY_ROOT, '1.MCP-MISC/awesome-mcp-servers-main/README.md');
  const awesomeMcps = await parseAwesomeMcpList(awesomePath);
  addMcpsToMap(awesomeMcps);

  // Scan each repo
  for (const repoConfig of REPO_CONFIGS) {
    const repoPath = path.join(INVENTORY_ROOT, repoConfig.name);

    for (const compPath of repoConfig.componentPaths) {
      const fullPath = path.join(repoPath, compPath.path);

      // For paths like plugins/feature-dev/agents, extract plugin name as category
      let categoryFromPath: string | undefined;
      if (compPath.categoryFromPath) {
        const parts = compPath.path.split('/');
        // e.g., "plugins/feature-dev/agents" -> "feature-dev"
        categoryFromPath = parts[parts.length - 2];
      }

      const components = await scanComponentDir(
        fullPath,
        compPath.type,
        repoConfig.name,
        categoryFromPath
      );

      for (const comp of components) {
        // Initialize nested maps if needed
        if (!typeMap.has(compPath.type)) {
          typeMap.set(compPath.type, new Map());
        }
        const repoMap = typeMap.get(compPath.type)!;

        if (!repoMap.has(comp.repo)) {
          repoMap.set(comp.repo, new Map());
        }
        const categoryMap = repoMap.get(comp.repo)!;

        if (!categoryMap.has(comp.category)) {
          categoryMap.set(comp.category, []);
        }
        categoryMap.get(comp.category)!.push(comp);
      }
    }
  }

  // Build the tree: type -> repo -> category -> components
  const tree: InventoryItem[] = [];

  for (const [typeName, repoMap] of typeMap) {
    const nodeType = TYPE_TO_NODE_TYPE[typeName] || 'AGENT';

    const typeFolder: InventoryItem = {
      id: typeName,
      name: typeName,
      path: typeName,
      type: 'folder',
      children: [],
    };

    for (const [repoName, categoryMap] of repoMap) {
      const repoFolder: InventoryItem = {
        id: `${typeName}/${repoName}`,
        name: repoName,
        path: `${typeName}/${repoName}`,
        type: 'folder',
        repo: repoName,
        children: [],
      };

      for (const [categoryName, components] of categoryMap) {
        const categoryFolder: InventoryItem = {
          id: `${typeName}/${repoName}/${categoryName}`,
          name: categoryName,
          path: `${typeName}/${repoName}/${categoryName}`,
          type: 'folder',
          repo: repoName,
          children: components.map(c => ({
            id: c.path,
            name: c.name,
            path: c.path,
            type: 'file' as const,
            category: nodeType,
            description: c.description,
            repo: repoName,
          })),
        };

        // Sort components within category alphabetically
        categoryFolder.children!.sort((a, b) => a.name.localeCompare(b.name));
        repoFolder.children!.push(categoryFolder);
      }

      // Sort categories alphabetically
      repoFolder.children!.sort((a, b) => a.name.localeCompare(b.name));
      typeFolder.children!.push(repoFolder);
    }

    // Sort repos alphabetically
    typeFolder.children!.sort((a, b) => a.name.localeCompare(b.name));
    tree.push(typeFolder);
  }

  // Sort type folders alphabetically
  tree.sort((a, b) => a.name.localeCompare(b.name));

  // Scan plugin bundles and add as a separate category
  const bundles = await scanPluginBundles();

  if (bundles.length > 0) {
    const bundlesFolder: InventoryItem = {
      id: 'bundles',
      name: 'bundles',
      path: 'bundles',
      type: 'folder',
      children: bundles,
    };
    tree.push(bundlesFolder);
  }

  // Re-sort to include bundles
  tree.sort((a, b) => a.name.localeCompare(b.name));

  return tree;
}
