// =============================================================================
// Credentials API Routes
//
// Exposes the credential vault: CRUD, validation, and a catalog listing for
// the Configure Wizard form builder. All secret fields are masked on read
// (••••••••) unless the caller explicitly requests reveal — preventing
// accidental exposure via list/search endpoints.
// =============================================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateBody } from '../src/middleware/validation';
import { AppError } from '../src/middleware/error-handler';
import {
  createCredential,
  getCredential,
  getCredentialDecrypted,
  findByProvider,
  findByCapability,
  listCredentials,
  updateCredential,
  deleteCredential,
  validateCredential,
} from '../services/credential-vault';
import { getProvider } from '../services/credential-catalog';
import { listAllProviders } from '../services/provider-registry';
import {
  generateProviderDefinition,
  ProviderGenerationError,
} from '../services/provider-generator';

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const createCredentialSchema = z.object({
  orgId: z.string().optional(),
  provider: z.string().min(1),
  name: z.string().min(1).max(200),
  values: z.record(z.string(), z.string()),
  tags: z.array(z.string()).optional(),
  envVarName: z.string().optional(),
  description: z.string().optional(),
  createdBy: z.string().optional(),
});

const updateCredentialSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  values: z.record(z.string(), z.string()).optional(),
  tags: z.array(z.string()).optional(),
  envVarName: z.string().optional(),
  description: z.string().optional(),
});

const generateProviderSchema = z.object({
  description: z.string().min(1).max(2000),
});

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

const router = Router();

/**
 * GET /api/credentials/catalog
 *
 * Lists provider definitions for the Configure Wizard form builder. Never
 * returns any stored credentials — just the schema of what *could* be stored.
 * Optional query params:
 *   - capability=<tag>     filter to providers with that capability
 *   - category=<category>  filter to providers in that category
 */
router.get('/catalog', (req: Request, res: Response) => {
  const { capability, category } = req.query;
  // Merge hardcoded catalog with any custom providers that have been generated
  // via POST /catalog/generate — the frontend picker sees everything.
  let providers = listAllProviders();

  if (typeof capability === 'string') {
    providers = providers.filter((p) => p.capabilities.includes(capability));
  }
  if (typeof category === 'string') {
    providers = providers.filter((p) => p.category === category);
  }

  // Strip validation rules (internal-only) and mcpConfig env mappings
  const safe = providers.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    description: p.description,
    credentialType: p.credentialType,
    fields: p.fields,
    signupUrl: p.signupUrl,
    signupSteps: p.signupSteps,
    freeTier: p.freeTier,
    docsUrl: p.docsUrl,
    capabilities: p.capabilities,
    hasValidation: Boolean(p.validation),
    hasMcpConfig: Boolean(p.mcpConfig),
  }));

  res.json({ providers: safe });
});

/**
 * POST /api/credentials/catalog/generate
 *
 * AI-assisted provider definition. Takes a one-line service description and
 * asks Claude to generate a ProviderDefinition JSON (fields, signup steps,
 * validation endpoint, etc.). The generated entry is persisted to
 * custom_provider_definitions and returned to the caller, so the Vault UI
 * can immediately render the typed CredentialForm against it.
 *
 * Body: { description: string }
 * Returns: { provider: ProviderDefinition (safe shape), warnings: string[] }
 */
router.post(
  '/catalog/generate',
  validateBody(generateProviderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { description } = req.body as { description: string };
      const result = await generateProviderDefinition(description);

      // Strip validation/mcpConfig details to match GET /catalog response shape
      const p = result.provider;
      const safe = {
        id: p.id,
        name: p.name,
        category: p.category,
        description: p.description,
        credentialType: p.credentialType,
        fields: p.fields,
        signupUrl: p.signupUrl,
        signupSteps: p.signupSteps,
        freeTier: p.freeTier,
        docsUrl: p.docsUrl,
        capabilities: p.capabilities,
        hasValidation: Boolean(p.validation),
        hasMcpConfig: Boolean(p.mcpConfig),
      };

      res.json({ provider: safe, warnings: result.warnings });
    } catch (error) {
      if (error instanceof ProviderGenerationError) {
        return next(
          new AppError(422, error.message, 'PROVIDER_GENERATION_FAILED')
        );
      }
      next(error);
    }
  }
);

/**
 * GET /api/credentials
 *
 * List credentials. Filters:
 *   - orgId         (defaults to 'default')
 *   - provider      limit to one provider id
 *   - capability    limit to providers that match a capability tag
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = typeof req.query.orgId === 'string' ? req.query.orgId : 'default';
    const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
    const capability = typeof req.query.capability === 'string' ? req.query.capability : undefined;

    let credentials;
    if (provider) {
      credentials = await findByProvider(orgId, provider);
    } else if (capability) {
      credentials = await findByCapability(orgId, capability);
    } else {
      credentials = await listCredentials(orgId);
    }

    res.json({ credentials });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/credentials/:id
 *
 * Fetch a single credential. Secret fields are masked unless ?reveal=true is
 * passed. Reveal is gated to the dedicated flow — the Configure Wizard should
 * never ask for reveal; only the "edit credential" screen should.
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reveal = req.query.reveal === 'true';
    const credential = reveal
      ? await getCredentialDecrypted(req.params.id)
      : await getCredential(req.params.id);

    if (!credential) {
      throw new AppError(404, `Credential "${req.params.id}" not found`, 'NOT_FOUND');
    }
    res.json(credential);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/credentials
 *
 * Create or upsert a credential (ON CONFLICT on org_id+provider+name updates
 * the existing row — this lets the user save the same logical key once).
 */
router.post(
  '/',
  validateBody(createCredentialSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = getProvider(req.body.provider);
      if (!provider) {
        throw new AppError(400, `Unknown provider: ${req.body.provider}`, 'UNKNOWN_PROVIDER');
      }
      const credential = await createCredential(req.body);
      res.status(201).json(credential);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Missing required field')) {
        return next(new AppError(400, error.message, 'MISSING_FIELD'));
      }
      next(error);
    }
  }
);

/**
 * PATCH /api/credentials/:id
 *
 * Partial update. If `values` is provided, it's merged with the existing
 * decrypted values before re-encrypting — so you can rotate a single field
 * without re-entering every field in a multi_field credential.
 */
router.patch(
  '/:id',
  validateBody(updateCredentialSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const credential = await updateCredential(req.params.id, req.body);
      if (!credential) {
        throw new AppError(404, `Credential "${req.params.id}" not found`, 'NOT_FOUND');
      }
      res.json(credential);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/credentials/:id
 *
 * Hard-delete. Usage tracking (used_by_systems) is informational only —
 * deleting a credential does NOT cascade-update running systems. Call
 * POST /api/credentials/:id/validate first or check usedBySystems in the
 * UI to warn the user.
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await deleteCredential(req.params.id);
    if (!deleted) {
      throw new AppError(404, `Credential "${req.params.id}" not found`, 'NOT_FOUND');
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/credentials/:id/validate
 *
 * Tests the stored credential against the provider's validation endpoint.
 * Updates last_validated_at + last_validation_status on the row and returns
 * the result synchronously. If the provider has no validation rule, returns
 * { status: 'skipped' } — the UI should treat that as "can't verify, trust
 * user input".
 */
router.post('/:id/validate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await validateCredential(req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export { router as credentialsRouter };
