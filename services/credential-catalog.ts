// =============================================================================
// Credential Provider Catalog
//
// Hand-curated definitions for known providers. When the Fixer identifies a
// capability gap (e.g., "Trend Scout needs web-search"), it maps to one or
// more providers here. The Configure Wizard checks the vault for existing
// credentials matching those providers; if none, it renders a typed form
// driven by the field definitions below.
//
// To add a new provider: append an entry to PROVIDER_CATALOG. Keep the
// signupSteps practical and specific — the user should be able to follow
// them start-to-finish without context-switching to docs.
// =============================================================================

export type CredentialCategory =
  | 'llm'
  | 'web-search'
  | 'scraping'
  | 'vector-db'
  | 'storage'
  | 'messaging'
  | 'other';

export type CredentialType =
  | 'api_key'        // Single string token
  | 'oauth_token'    // OAuth flow completed, bearer token stored
  | 'multi_field'    // Multiple fields (e.g., AWS access_key_id + secret_access_key)
  | 'text_reference'; // Free-form text (style guide, brand voice, etc.)

export interface CredentialField {
  name: string;           // 'apiKey', 'accessKeyId', 'region'
  label: string;          // Human-readable label
  placeholder: string;    // UI placeholder
  description?: string;   // Help text
  required: boolean;
  secret: boolean;        // Mask in UI + never return from API reads
  format?: string;        // Regex string for client-side validation
  formatHint?: string;    // Human-readable format description
}

export interface ValidationRule {
  url: string;                             // Test endpoint
  method: 'GET' | 'POST';
  headers?: Record<string, string>;        // Templated with {fieldName} refs
  body?: string;                           // Templated
  expectedStatus: number;
  timeoutMs?: number;
}

export interface McpConfigTemplate {
  command: string;
  args: string[];
  envVars: Record<string, string>;         // Maps env var name → credential field name (e.g., BRAVE_API_KEY: apiKey)
}

export interface ProviderDefinition {
  id: string;                              // Stable identifier, used as DB key
  name: string;                            // Display name
  category: CredentialCategory;
  description: string;                     // One-sentence summary for the UI
  credentialType: CredentialType;
  fields: CredentialField[];
  signupUrl?: string;
  signupSteps?: string[];
  freeTier?: string;                       // 'Free tier: 2K queries/mo'
  docsUrl?: string;
  validation?: ValidationRule;
  mcpConfig?: McpConfigTemplate;           // If set, this credential can be mounted as an MCP server
  capabilities: string[];                  // Capability tags — the fixer queries by these: ['web-search', 'real-time-data']
}

// -----------------------------------------------------------------------------
// Catalog
// -----------------------------------------------------------------------------

export const PROVIDER_CATALOG: ProviderDefinition[] = [
  // ─── LLM providers ────────────────────────────────────────────────────────
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    category: 'llm',
    description: 'Claude API — used by every agent by default for execution and planning.',
    credentialType: 'api_key',
    fields: [{
      name: 'apiKey',
      label: 'Anthropic API Key',
      placeholder: 'sk-ant-api03-...',
      description: 'Starts with sk-ant-api03- and is ~100 chars long',
      required: true,
      secret: true,
      format: '^sk-ant-api[0-9]+-[a-zA-Z0-9_-]+$',
      formatHint: 'sk-ant-api03-… (from console.anthropic.com)',
    }],
    signupUrl: 'https://console.anthropic.com/settings/keys',
    signupSteps: [
      'Go to console.anthropic.com and sign in or create an account',
      'Add billing (Plan → add a payment method) to activate the API',
      'Navigate to Settings → API Keys → Create Key',
      'Choose a workspace (or create one) and name the key',
      'Copy the key — it starts with sk-ant-api03- and is shown only once',
    ],
    freeTier: 'No free tier, but $5 credit on signup',
    docsUrl: 'https://docs.anthropic.com/en/api/getting-started',
    validation: {
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': '{apiKey}',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: '{"model":"claude-haiku-4-5-20251001","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}',
      expectedStatus: 200,
      timeoutMs: 10000,
    },
    capabilities: ['llm', 'reasoning', 'tool-use'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'llm',
    description: 'OpenAI API — used for text-embedding-3-large (vault semantic search) and GPT models.',
    credentialType: 'api_key',
    fields: [{
      name: 'apiKey',
      label: 'OpenAI API Key',
      placeholder: 'sk-proj-... or sk-...',
      description: 'Starts with sk-proj- (project keys) or sk- (legacy user keys)',
      required: true,
      secret: true,
      format: '^sk-(proj-)?[a-zA-Z0-9_-]+$',
      formatHint: 'sk-proj-… (from platform.openai.com)',
    }],
    signupUrl: 'https://platform.openai.com/api-keys',
    signupSteps: [
      'Go to platform.openai.com and sign in',
      'Add billing (Settings → Billing) — the API requires a payment method',
      'Go to API Keys → Create new secret key',
      'Choose "Project" scope (recommended) and name the key',
      'Copy the key — it starts with sk-proj- and is only shown once',
    ],
    freeTier: 'No free tier',
    docsUrl: 'https://platform.openai.com/docs/api-reference/authentication',
    validation: {
      url: 'https://api.openai.com/v1/models',
      method: 'GET',
      headers: { 'Authorization': 'Bearer {apiKey}' },
      expectedStatus: 200,
      timeoutMs: 10000,
    },
    capabilities: ['llm', 'embeddings', 'image-generation'],
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    category: 'llm',
    description: 'Google Gemini API — used by the Router Agent for fast intent classification.',
    credentialType: 'api_key',
    fields: [{
      name: 'apiKey',
      label: 'Google AI Studio API Key',
      placeholder: 'AIzaSy...',
      description: 'Starts with AIzaSy. Get from Google AI Studio, not Google Cloud Console.',
      required: true,
      secret: true,
      format: '^AIza[a-zA-Z0-9_-]+$',
      formatHint: 'AIzaSy… (from aistudio.google.com)',
    }],
    signupUrl: 'https://aistudio.google.com/apikey',
    signupSteps: [
      'Go to aistudio.google.com and sign in with Google',
      'Click "Get API key" in the left sidebar',
      'Click "Create API key" and select or create a Google Cloud project',
      'Copy the key — starts with AIzaSy',
    ],
    freeTier: 'Free tier: 15 req/min, 1500 req/day (Gemini 2.0 Flash)',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    validation: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models?key={apiKey}',
      method: 'GET',
      expectedStatus: 200,
      timeoutMs: 10000,
    },
    capabilities: ['llm', 'reasoning', 'intent-classification'],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    category: 'llm',
    description: 'xAI Grok API — alternative LLM with real-time X/Twitter data access.',
    credentialType: 'api_key',
    fields: [{
      name: 'apiKey',
      label: 'xAI API Key',
      placeholder: 'xai-...',
      required: true,
      secret: true,
      format: '^xai-[a-zA-Z0-9]+$',
      formatHint: 'xai-… (from console.x.ai)',
    }],
    signupUrl: 'https://console.x.ai',
    signupSteps: [
      'Go to console.x.ai and sign in',
      'Add billing (Settings → Billing)',
      'Go to API Keys → Create Key',
      'Copy the key — starts with xai-',
    ],
    freeTier: '$150/month free credits during beta',
    docsUrl: 'https://docs.x.ai/',
    validation: {
      url: 'https://api.x.ai/v1/api-key',
      method: 'GET',
      headers: { 'Authorization': 'Bearer {apiKey}' },
      expectedStatus: 200,
      timeoutMs: 10000,
    },
    capabilities: ['llm', 'real-time-data'],
  },

  // ─── Web search ────────────────────────────────────────────────────────
  {
    id: 'brave-search',
    name: 'Brave Search',
    category: 'web-search',
    description: 'Independent search index with AI-optimized API. Recommended default for web search.',
    credentialType: 'api_key',
    fields: [{
      name: 'apiKey',
      label: 'Brave Search API Key',
      placeholder: 'BSA...',
      description: 'Subscription token from the Brave Search API dashboard',
      required: true,
      secret: true,
      format: '^BSA[a-zA-Z0-9_-]+$',
      formatHint: 'BSA… (from api.search.brave.com)',
    }],
    signupUrl: 'https://brave.com/search/api/',
    signupSteps: [
      'Go to brave.com/search/api and click "Get started for free"',
      'Create an account and verify your email',
      'Choose the "Data for AI" free plan (2K queries/month)',
      'Add a payment method (required even for the free tier, no charge)',
      'Go to Dashboard → API Keys → Add a subscription token',
      'Copy the token — starts with BSA',
    ],
    freeTier: '2,000 queries/month',
    docsUrl: 'https://api.search.brave.com/app/documentation',
    validation: {
      url: 'https://api.search.brave.com/res/v1/web/search?q=test&count=1',
      method: 'GET',
      headers: { 'X-Subscription-Token': '{apiKey}' },
      expectedStatus: 200,
      timeoutMs: 10000,
    },
    mcpConfig: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      envVars: { BRAVE_API_KEY: 'apiKey' },
    },
    capabilities: ['web-search', 'real-time-data'],
  },
  {
    id: 'serpapi',
    name: 'SerpAPI',
    category: 'web-search',
    description: 'Google, Bing, and other search engine results via API. More structured output than Brave.',
    credentialType: 'api_key',
    fields: [{
      name: 'apiKey',
      label: 'SerpAPI Key',
      placeholder: '(64-char hex string)',
      description: '64-character hex string from your SerpAPI dashboard',
      required: true,
      secret: true,
      format: '^[a-f0-9]{64}$',
      formatHint: '64-char hex (from serpapi.com)',
    }],
    signupUrl: 'https://serpapi.com/users/sign_up',
    signupSteps: [
      'Go to serpapi.com/users/sign_up and create an account',
      'Verify your email',
      'Go to Dashboard → Your API Key',
      'Copy the 64-character hex key',
    ],
    freeTier: '100 searches/month free',
    docsUrl: 'https://serpapi.com/search-api',
    validation: {
      url: 'https://serpapi.com/account?api_key={apiKey}',
      method: 'GET',
      expectedStatus: 200,
      timeoutMs: 10000,
    },
    capabilities: ['web-search', 'google-results'],
  },
  {
    id: 'tavily',
    name: 'Tavily',
    category: 'web-search',
    description: 'Search API optimized for LLM consumption. Returns pre-summarized, cited results.',
    credentialType: 'api_key',
    fields: [{
      name: 'apiKey',
      label: 'Tavily API Key',
      placeholder: 'tvly-...',
      required: true,
      secret: true,
      format: '^tvly-[a-zA-Z0-9_-]+$',
      formatHint: 'tvly-… (from tavily.com dashboard)',
    }],
    signupUrl: 'https://tavily.com/',
    signupSteps: [
      'Go to tavily.com and click "Start Free"',
      'Sign up with Google or email',
      'Go to Dashboard → API Keys',
      'Copy the key — starts with tvly-',
    ],
    freeTier: '1,000 searches/month free',
    docsUrl: 'https://docs.tavily.com/',
    validation: {
      url: 'https://api.tavily.com/search',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"api_key":"{apiKey}","query":"test","max_results":1}',
      expectedStatus: 200,
      timeoutMs: 15000,
    },
    capabilities: ['web-search', 'llm-optimized'],
  },

  // ─── Scraping ────────────────────────────────────────────────────────
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    category: 'scraping',
    description: 'Web scraping API that returns clean markdown. Handles JS-rendered sites.',
    credentialType: 'api_key',
    fields: [{
      name: 'apiKey',
      label: 'Firecrawl API Key',
      placeholder: 'fc-...',
      required: true,
      secret: true,
      format: '^fc-[a-zA-Z0-9]+$',
      formatHint: 'fc-… (from firecrawl.dev)',
    }],
    signupUrl: 'https://www.firecrawl.dev/',
    signupSteps: [
      'Go to firecrawl.dev and click "Sign up"',
      'Sign up with GitHub or email',
      'Go to Dashboard → API Keys',
      'Copy the key — starts with fc-',
    ],
    freeTier: '500 pages/month free',
    docsUrl: 'https://docs.firecrawl.dev/',
    validation: {
      url: 'https://api.firecrawl.dev/v1/scrape',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer {apiKey}',
        'content-type': 'application/json',
      },
      body: '{"url":"https://example.com"}',
      expectedStatus: 200,
      timeoutMs: 30000,
    },
    capabilities: ['scraping', 'markdown-conversion', 'js-rendering'],
  },
  {
    id: 'jina',
    name: 'Jina Reader',
    category: 'scraping',
    description: 'URL-to-markdown reader + embeddings + search API.',
    credentialType: 'api_key',
    fields: [{
      name: 'apiKey',
      label: 'Jina API Key',
      placeholder: 'jina_...',
      required: true,
      secret: true,
      format: '^jina_[a-zA-Z0-9_]+$',
      formatHint: 'jina_… (from jina.ai)',
    }],
    signupUrl: 'https://jina.ai/reader/',
    signupSteps: [
      'Go to jina.ai/reader and click "Get API Key"',
      'Sign up with Google or email',
      'Free tier: 1M tokens/month without sign-up (limited IPs)',
      'With sign-up: additional quota',
      'Copy your key from the dashboard',
    ],
    freeTier: '1M tokens/month free (no signup needed)',
    docsUrl: 'https://jina.ai/reader',
    validation: {
      url: 'https://r.jina.ai/https://example.com',
      method: 'GET',
      headers: { 'Authorization': 'Bearer {apiKey}' },
      expectedStatus: 200,
      timeoutMs: 20000,
    },
    capabilities: ['scraping', 'markdown-conversion', 'embeddings'],
  },

  // ─── Vector DB ────────────────────────────────────────────────────────
  {
    id: 'pinecone',
    name: 'Pinecone',
    category: 'vector-db',
    description: 'Managed vector database. Alternative to local pgvector for larger scale.',
    credentialType: 'multi_field',
    fields: [
      {
        name: 'apiKey',
        label: 'Pinecone API Key',
        placeholder: '(UUID format)',
        required: true,
        secret: true,
        format: '^[a-f0-9-]{36}$',
        formatHint: 'UUID format (from app.pinecone.io)',
      },
      {
        name: 'environment',
        label: 'Environment',
        placeholder: 'us-east-1-aws',
        description: 'The region your index is in, shown in the Pinecone dashboard',
        required: true,
        secret: false,
      },
    ],
    signupUrl: 'https://app.pinecone.io/',
    signupSteps: [
      'Go to app.pinecone.io and sign up',
      'Create a free "Starter" project (1 index, 100K vectors)',
      'API Keys → Create Key → Copy',
      'Note the environment shown in the dashboard (e.g., us-east-1-aws)',
    ],
    freeTier: 'Starter: 1 index, 100K vectors, 2M write units/month',
    docsUrl: 'https://docs.pinecone.io/',
    capabilities: ['vector-search', 'managed-db'],
  },
  {
    id: 'gcp-vertex-vector',
    name: 'Google Cloud Vertex AI Vector Search',
    category: 'vector-db',
    description: 'Managed vector search on GCP. Requires a service account JSON key.',
    credentialType: 'multi_field',
    fields: [
      {
        name: 'serviceAccountJson',
        label: 'Service Account JSON',
        placeholder: '{"type":"service_account",...}',
        description: 'Paste the entire JSON file contents from GCP IAM → Service Accounts → Keys',
        required: true,
        secret: true,
      },
      {
        name: 'projectId',
        label: 'GCP Project ID',
        placeholder: 'my-project-123456',
        required: true,
        secret: false,
      },
      {
        name: 'location',
        label: 'Location',
        placeholder: 'us-central1',
        required: true,
        secret: false,
      },
    ],
    signupUrl: 'https://console.cloud.google.com/',
    signupSteps: [
      'Go to console.cloud.google.com',
      'Create or select a project',
      'Enable the Vertex AI API (APIs & Services → Library → Vertex AI)',
      'Go to IAM & Admin → Service Accounts → Create',
      'Grant the role "Vertex AI User"',
      'Create a JSON key for the service account and download it',
      'Paste the JSON contents into the field',
    ],
    docsUrl: 'https://cloud.google.com/vertex-ai/docs/vector-search/overview',
    capabilities: ['vector-search', 'managed-db', 'gcp'],
  },

  // ─── Storage ────────────────────────────────────────────────────────
  {
    id: 'aws-s3',
    name: 'AWS S3',
    category: 'storage',
    description: 'Object storage. Use for uploading artifacts, receiving files from agents.',
    credentialType: 'multi_field',
    fields: [
      {
        name: 'accessKeyId',
        label: 'Access Key ID',
        placeholder: 'AKIA...',
        required: true,
        secret: false,
        format: '^(AKIA|ASIA)[A-Z0-9]{16}$',
        formatHint: 'AKIA… (20 chars)',
      },
      {
        name: 'secretAccessKey',
        label: 'Secret Access Key',
        placeholder: '(40-char string)',
        required: true,
        secret: true,
        format: '^[a-zA-Z0-9/+=]{40}$',
        formatHint: '40 chars',
      },
      {
        name: 'region',
        label: 'Region',
        placeholder: 'us-east-1',
        required: true,
        secret: false,
      },
      {
        name: 'bucket',
        label: 'Default bucket (optional)',
        placeholder: 'my-autopilate-artifacts',
        required: false,
        secret: false,
      },
    ],
    signupUrl: 'https://aws.amazon.com/',
    signupSteps: [
      'Sign in to AWS Console',
      'Go to IAM → Users → Create User',
      'Attach policy: AmazonS3FullAccess (or a scoped custom policy for one bucket)',
      'Security credentials → Access keys → Create access key',
      'Choose "Application running outside AWS"',
      'Copy the Access Key ID and Secret Access Key',
    ],
    freeTier: '5GB free tier for 12 months',
    docsUrl: 'https://docs.aws.amazon.com/s3/',
    capabilities: ['storage', 'object-storage'],
  },
  {
    id: 'gcp-storage',
    name: 'Google Cloud Storage',
    category: 'storage',
    description: 'Object storage on GCP. Service account JSON auth.',
    credentialType: 'multi_field',
    fields: [
      {
        name: 'serviceAccountJson',
        label: 'Service Account JSON',
        placeholder: '{"type":"service_account",...}',
        description: 'Paste the entire JSON file from GCP IAM → Service Accounts → Keys',
        required: true,
        secret: true,
      },
      {
        name: 'projectId',
        label: 'GCP Project ID',
        placeholder: 'my-project-123456',
        required: true,
        secret: false,
      },
      {
        name: 'bucket',
        label: 'Default bucket (optional)',
        placeholder: 'my-autopilate-artifacts',
        required: false,
        secret: false,
      },
    ],
    signupUrl: 'https://console.cloud.google.com/',
    signupSteps: [
      'Go to console.cloud.google.com',
      'Select or create a project',
      'Enable the Cloud Storage API',
      'IAM & Admin → Service Accounts → Create',
      'Grant role "Storage Object Admin"',
      'Keys → Add key → Create new JSON key → Download',
      'Paste the JSON contents into the field',
    ],
    freeTier: '5GB free tier',
    docsUrl: 'https://cloud.google.com/storage/docs',
    capabilities: ['storage', 'object-storage', 'gcp'],
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    category: 'storage',
    description: 'Google Drive via OAuth — read/write user files and folders.',
    credentialType: 'oauth_token',
    fields: [
      {
        name: 'clientId',
        label: 'OAuth Client ID',
        placeholder: '(from GCP OAuth 2.0 credentials)',
        required: true,
        secret: false,
      },
      {
        name: 'clientSecret',
        label: 'OAuth Client Secret',
        placeholder: '(from GCP OAuth 2.0 credentials)',
        required: true,
        secret: true,
      },
      {
        name: 'refreshToken',
        label: 'Refresh Token',
        placeholder: '(obtained via OAuth consent flow)',
        description: 'Generate this by running the OAuth consent flow once. We do not host the flow — use Google OAuth Playground or a one-time script.',
        required: true,
        secret: true,
      },
    ],
    signupUrl: 'https://console.cloud.google.com/apis/credentials',
    signupSteps: [
      'Go to console.cloud.google.com/apis/credentials',
      'Create OAuth 2.0 Client ID (type: Desktop app)',
      'Download the client ID and secret',
      'Go to https://developers.google.com/oauthplayground/',
      'In settings, enable "Use your own OAuth credentials" and paste ID + secret',
      'Select "Drive API v3" → https://www.googleapis.com/auth/drive scope',
      'Authorize → Exchange code for tokens → copy the refresh_token',
    ],
    docsUrl: 'https://developers.google.com/drive/api/guides/about-sdk',
    capabilities: ['storage', 'documents', 'oauth'],
  },

  // ─── Messaging ────────────────────────────────────────────────────────
  {
    id: 'slack',
    name: 'Slack',
    category: 'messaging',
    description: 'Slack workspace bot — receive messages, post replies, upload files.',
    credentialType: 'multi_field',
    fields: [
      {
        name: 'botToken',
        label: 'Bot User OAuth Token',
        placeholder: 'xoxb-...',
        description: 'From your Slack app settings → OAuth & Permissions',
        required: true,
        secret: true,
        format: '^xoxb-[a-zA-Z0-9-]+$',
        formatHint: 'xoxb-…',
      },
      {
        name: 'appToken',
        label: 'App-Level Token',
        placeholder: 'xapp-...',
        description: 'From Basic Information → App-Level Tokens (connections:write scope)',
        required: true,
        secret: true,
        format: '^xapp-[0-9]+-[a-zA-Z0-9-]+$',
        formatHint: 'xapp-…',
      },
    ],
    signupUrl: 'https://api.slack.com/apps',
    signupSteps: [
      'Go to api.slack.com/apps and click "Create New App" → "From scratch"',
      'Name your app and pick your workspace',
      'Socket Mode → Enable Socket Mode → generate an App-Level Token with connections:write',
      'OAuth & Permissions → add scopes: app_mentions:read, chat:write, im:history, im:read, im:write',
      'Install App to Workspace → copy the Bot User OAuth Token (xoxb-…)',
      'Event Subscriptions → Enable → subscribe to: message.im, app_mention',
      'Reinstall the app if you changed scopes',
    ],
    docsUrl: 'https://api.slack.com/authentication/socket-mode',
    validation: {
      url: 'https://slack.com/api/auth.test',
      method: 'POST',
      headers: { 'Authorization': 'Bearer {botToken}' },
      expectedStatus: 200,
      timeoutMs: 10000,
    },
    capabilities: ['messaging', 'chat-ingress', 'oauth'],
  },

  // ─── Text References (not a real provider — acts like one for UX) ────
  {
    id: 'text-reference',
    name: 'Text Reference',
    category: 'other',
    description: 'Free-form text reference (style guide, brand voice, example documents, instructions).',
    credentialType: 'text_reference',
    fields: [{
      name: 'content',
      label: 'Content',
      placeholder: 'Paste your style guide, brand voice document, or reference text here...',
      description: 'Markdown supported. This text will be made available to agents that need it.',
      required: true,
      secret: false,
    }],
    capabilities: ['reference', 'style-guide', 'brand-voice'],
  },
];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

export function getProvider(id: string): ProviderDefinition | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

export function findProvidersByCapability(capability: string): ProviderDefinition[] {
  return PROVIDER_CATALOG.filter((p) => p.capabilities.includes(capability));
}

export function findProvidersByCategory(category: CredentialCategory): ProviderDefinition[] {
  return PROVIDER_CATALOG.filter((p) => p.category === category);
}
