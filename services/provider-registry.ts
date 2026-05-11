// =============================================================================
// Provider Registry
//
// Single lookup surface that merges the hardcoded PROVIDER_CATALOG with the
// in-memory custom provider store. Callers in credential-vault.ts and
// deploy-bridge.ts should use this module's functions instead of importing
// getProvider from credential-catalog.ts directly — that way any ProviderDefinition
// generated at runtime (via AI-assisted add flow) resolves transparently.
//
// Lookup order: hardcoded catalog wins, then custom store. This means a user
// can't override an existing catalog entry by generating a new one with the
// same id — intentional, so the curated defaults can't drift.
// =============================================================================

import {
  PROVIDER_CATALOG,
  getProvider as getCatalogProvider,
  type ProviderDefinition,
} from './credential-catalog';
import {
  getCustomProvider,
  listCustomProviders,
} from './custom-provider-store';

export type { ProviderDefinition } from './credential-catalog';

/**
 * Resolve a provider id against the hardcoded catalog first, then the
 * custom store. Returns undefined if neither knows the id.
 */
export function getProviderAny(id: string): ProviderDefinition | undefined {
  return getCatalogProvider(id) ?? getCustomProvider(id);
}

/**
 * Snapshot of every provider visible to the vault — hardcoded + custom.
 * Used by the catalog REST endpoint and the credential-vault capability
 * filter helper.
 */
export function listAllProviders(): ProviderDefinition[] {
  return [...PROVIDER_CATALOG, ...listCustomProviders()];
}

/**
 * Capability filter across the merged view. Mirrors the semantics of
 * findProvidersByCapability in credential-catalog.ts but includes custom
 * providers so newly generated services participate in Fixer lookups.
 */
export function findProvidersByCapabilityAny(capability: string): ProviderDefinition[] {
  return listAllProviders().filter((p) => p.capabilities.includes(capability));
}
