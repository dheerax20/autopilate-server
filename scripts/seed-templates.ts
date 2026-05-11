// =============================================================================
// Seed starter templates into the marketplace
// Usage: cd server && npx tsx scripts/seed-templates.ts
// =============================================================================

import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/autopilate';

interface TemplateData {
  name: string;
  slug: string;
  description: string;
  longDescription: string;
  category: string;
  tags: string[];
  version: string;
  author: string;
  manifestJson: unknown;
  canvasJson: unknown;
  agentConfigs: Record<string, unknown>;
  mcpConfigs: unknown[];
  envExample: Record<string, string>;
  outputType: string;
  triggerPattern: string;
  estimatedCostUsd: number;
  nodeCount: number;
  edgeCount: number;
  featured: boolean;
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function node(
  id: string,
  label: string,
  role: string,
  x: number,
  y: number
): { id: string; type: string; position: { x: number; y: number }; data: { label: string; role: string; type: string } } {
  return {
    id,
    type: 'agent',
    position: { x, y },
    data: { label, role, type: 'AGENT' },
  };
}

function edge(
  source: string,
  target: string
): { id: string; source: string; target: string; type: string } {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    type: 'default',
  };
}

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

const templates: TemplateData[] = [
  // 1. Daily News Digest
  {
    name: 'Daily News Digest',
    slug: 'daily-news-digest',
    description: 'Researches top news stories and produces a formatted daily digest',
    longDescription:
      'This system monitors top news sources every morning, summarizes key stories, and compiles them into a clean daily digest. The Research Agent fetches headlines and articles, the Writer Agent distills each into concise summaries, and the Formatter produces the final output document.',
    category: 'content-production',
    tags: ['news', 'daily', 'digest', 'content'],
    version: '1.0.0',
    author: 'AUTOPILATE',
    manifestJson: {
      name: 'Daily News Digest',
      slug: 'daily-news-digest',
      description: 'Researches top news stories and produces a formatted daily digest',
      version: '1.0.0',
      category: 'content-production',
      requiredInputs: [
        { name: 'topics', type: 'string', description: 'Comma-separated topics to track', required: false },
        { name: 'max_stories', type: 'number', description: 'Maximum stories to include', required: false },
      ],
      outputType: 'document',
      estimatedCostUsd: 0.15,
      triggerPattern: 'cron',
      nodeCount: 3,
      edgeCount: 2,
    },
    canvasJson: {
      nodes: [
        node('research-agent', 'Research Agent', 'researcher', 100, 200),
        node('writer-agent', 'Writer Agent', 'writer', 400, 200),
        node('formatter', 'Formatter', 'formatter', 700, 200),
      ],
      edges: [
        edge('research-agent', 'writer-agent'),
        edge('writer-agent', 'formatter'),
      ],
    },
    agentConfigs: {
      'research-agent': {
        name: 'Research Agent',
        role: 'researcher',
        description: 'Fetches top headlines and articles from configured news sources',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are a news research agent. Gather the top stories of the day from reputable sources. Return structured data with headline, source, summary, and URL for each story.',
        mcps: [],
      },
      'writer-agent': {
        name: 'Writer Agent',
        role: 'writer',
        description: 'Distills raw research into concise, engaging summaries',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are a news writer. Take raw article data and produce concise, engaging summaries suitable for a daily digest. Maintain a neutral, informative tone.',
        mcps: [],
      },
      formatter: {
        name: 'Formatter',
        role: 'formatter',
        description: 'Compiles summaries into a formatted digest document',
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: 'You are a document formatter. Take the summarized stories and produce a clean, well-structured daily digest in Markdown format with sections, timestamps, and source links.',
        mcps: [],
      },
    },
    mcpConfigs: [],
    envExample: {
      ANTHROPIC_API_KEY: 'sk-ant-...',
      NEWS_API_KEY: 'your-news-api-key',
    },
    outputType: 'document',
    triggerPattern: 'cron',
    estimatedCostUsd: 0.15,
    nodeCount: 3,
    edgeCount: 2,
    featured: true,
  },

  // 2. Website Health Monitor
  {
    name: 'Website Health Monitor',
    slug: 'website-health-monitor',
    description: 'Checks website uptime, SSL certificate, and response times every 5 minutes',
    longDescription:
      'Continuously monitors your websites for downtime, SSL certificate issues, and slow response times. The HTTP Checker pings endpoints, the Analyzer evaluates the results against thresholds, and the Alerter sends notifications when issues are detected.',
    category: 'monitoring',
    tags: ['monitoring', 'uptime', 'health', 'alerts'],
    version: '1.0.0',
    author: 'AUTOPILATE',
    manifestJson: {
      name: 'Website Health Monitor',
      slug: 'website-health-monitor',
      description: 'Checks website uptime, SSL certificate, and response times every 5 minutes',
      version: '1.0.0',
      category: 'monitoring',
      requiredInputs: [
        { name: 'urls', type: 'string', description: 'Comma-separated list of URLs to monitor', required: true },
        { name: 'alert_email', type: 'string', description: 'Email address for alerts', required: true },
      ],
      outputType: 'notification',
      estimatedCostUsd: 0.02,
      triggerPattern: 'cron',
      nodeCount: 3,
      edgeCount: 2,
    },
    canvasJson: {
      nodes: [
        node('http-checker', 'HTTP Checker', 'checker', 100, 200),
        node('analyzer', 'Analyzer', 'analyst', 400, 200),
        node('alerter', 'Alerter', 'notifier', 700, 200),
      ],
      edges: [
        edge('http-checker', 'analyzer'),
        edge('analyzer', 'alerter'),
      ],
    },
    agentConfigs: {
      'http-checker': {
        name: 'HTTP Checker',
        role: 'checker',
        description: 'Performs HTTP requests and records response status, time, and SSL details',
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: 'You are an HTTP health checker. For each URL, perform a GET request and record: HTTP status code, response time in ms, SSL certificate expiry date, and any connection errors.',
        mcps: [],
      },
      analyzer: {
        name: 'Analyzer',
        role: 'analyst',
        description: 'Evaluates health check results against configured thresholds',
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: 'You are a health analysis agent. Review HTTP check results and flag issues: status != 200, response time > 3000ms, SSL expiry within 14 days, or connection failures. Output a structured report.',
        mcps: [],
      },
      alerter: {
        name: 'Alerter',
        role: 'notifier',
        description: 'Sends alerts when issues are detected',
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: 'You are an alert dispatcher. If any issues are flagged, compose a clear, actionable alert message. If no issues, produce an "all clear" status.',
        mcps: [],
      },
    },
    mcpConfigs: [],
    envExample: {
      ANTHROPIC_API_KEY: 'sk-ant-...',
      ALERT_EMAIL: 'ops@example.com',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/...',
    },
    outputType: 'notification',
    triggerPattern: 'cron',
    estimatedCostUsd: 0.02,
    nodeCount: 3,
    edgeCount: 2,
    featured: false,
  },

  // 3. Competitor Price Tracker
  {
    name: 'Competitor Price Tracker',
    slug: 'competitor-price-tracker',
    description: 'Scrapes competitor pricing data and generates comparison reports',
    longDescription:
      'Track competitor pricing across multiple products and marketplaces. The Scraper Agent collects current pricing data, the Data Processor normalizes and compares it against your own prices, and the Report Generator produces actionable pricing intelligence reports.',
    category: 'data-analysis',
    tags: ['pricing', 'competitive', 'analysis', 'scraping'],
    version: '1.0.0',
    author: 'AUTOPILATE',
    manifestJson: {
      name: 'Competitor Price Tracker',
      slug: 'competitor-price-tracker',
      description: 'Scrapes competitor pricing data and generates comparison reports',
      version: '1.0.0',
      category: 'data-analysis',
      requiredInputs: [
        { name: 'competitor_urls', type: 'string', description: 'URLs of competitor product pages', required: true },
        { name: 'own_prices_csv', type: 'string', description: 'Path to CSV with your current prices', required: false },
      ],
      outputType: 'data',
      estimatedCostUsd: 0.25,
      triggerPattern: 'cron',
      nodeCount: 3,
      edgeCount: 2,
    },
    canvasJson: {
      nodes: [
        node('scraper-agent', 'Scraper Agent', 'scraper', 100, 200),
        node('data-processor', 'Data Processor', 'processor', 400, 200),
        node('report-generator', 'Report Generator', 'reporter', 700, 200),
      ],
      edges: [
        edge('scraper-agent', 'data-processor'),
        edge('data-processor', 'report-generator'),
      ],
    },
    agentConfigs: {
      'scraper-agent': {
        name: 'Scraper Agent',
        role: 'scraper',
        description: 'Navigates competitor pages and extracts pricing data',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are a web scraping agent. Visit competitor product pages and extract: product name, current price, sale price (if any), currency, and timestamp. Return structured JSON data.',
        mcps: [],
      },
      'data-processor': {
        name: 'Data Processor',
        role: 'processor',
        description: 'Normalizes pricing data and computes comparisons',
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: 'You are a data processing agent. Normalize scraped pricing data to a common currency, compute price differences, detect trends, and flag significant changes (>5% movement).',
        mcps: [],
      },
      'report-generator': {
        name: 'Report Generator',
        role: 'reporter',
        description: 'Produces formatted pricing comparison reports',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are a business intelligence reporter. Create a clear pricing comparison report with tables, trend arrows, and actionable recommendations. Output in Markdown format.',
        mcps: [],
      },
    },
    mcpConfigs: [],
    envExample: {
      ANTHROPIC_API_KEY: 'sk-ant-...',
      BROWSER_AUTOMATION_URL: 'http://localhost:9222',
    },
    outputType: 'data',
    triggerPattern: 'cron',
    estimatedCostUsd: 0.25,
    nodeCount: 3,
    edgeCount: 2,
    featured: false,
  },

  // 4. Social Media Content Pipeline
  {
    name: 'Social Media Content Pipeline',
    slug: 'social-media-content-pipeline',
    description: 'Generates and schedules social media posts across platforms',
    longDescription:
      'An end-to-end content pipeline for social media. The Trend Researcher identifies trending topics in your niche, the Content Writer crafts platform-optimized posts, the Image Prompt agent generates visual descriptions for AI image generation, and the Scheduler queues posts for optimal timing.',
    category: 'content-production',
    tags: ['social-media', 'content', 'marketing', 'automation'],
    version: '1.0.0',
    author: 'AUTOPILATE',
    manifestJson: {
      name: 'Social Media Content Pipeline',
      slug: 'social-media-content-pipeline',
      description: 'Generates and schedules social media posts across platforms',
      version: '1.0.0',
      category: 'content-production',
      requiredInputs: [
        { name: 'brand_voice', type: 'string', description: 'Description of your brand voice and tone', required: true },
        { name: 'platforms', type: 'string', description: 'Target platforms (twitter, linkedin, instagram)', required: true },
        { name: 'niche', type: 'string', description: 'Industry or content niche', required: true },
      ],
      outputType: 'document',
      estimatedCostUsd: 0.30,
      triggerPattern: 'cron',
      nodeCount: 4,
      edgeCount: 3,
    },
    canvasJson: {
      nodes: [
        node('trend-researcher', 'Trend Researcher', 'researcher', 100, 200),
        node('content-writer', 'Content Writer', 'writer', 400, 200),
        node('image-prompt', 'Image Prompt', 'creative', 400, 400),
        node('scheduler', 'Scheduler', 'scheduler', 700, 300),
      ],
      edges: [
        edge('trend-researcher', 'content-writer'),
        edge('content-writer', 'image-prompt'),
        edge('image-prompt', 'scheduler'),
      ],
    },
    agentConfigs: {
      'trend-researcher': {
        name: 'Trend Researcher',
        role: 'researcher',
        description: 'Identifies trending topics and hashtags in the target niche',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are a social media trend researcher. Identify current trending topics, hashtags, and conversation themes in the specified niche. Prioritize trends with high engagement potential.',
        mcps: [],
      },
      'content-writer': {
        name: 'Content Writer',
        role: 'writer',
        description: 'Crafts platform-optimized social media posts',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are a social media content writer. Create engaging posts optimized for each platform. Follow character limits, include relevant hashtags, and match the specified brand voice.',
        mcps: [],
      },
      'image-prompt': {
        name: 'Image Prompt',
        role: 'creative',
        description: 'Generates image descriptions for visual content',
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: 'You are a visual content strategist. For each social media post, create a detailed image generation prompt that complements the text content and aligns with the brand aesthetic.',
        mcps: [],
      },
      scheduler: {
        name: 'Scheduler',
        role: 'scheduler',
        description: 'Queues posts for optimal publishing times',
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: 'You are a social media scheduler. Organize the content calendar, assign optimal posting times based on platform best practices, and output a structured schedule.',
        mcps: [],
      },
    },
    mcpConfigs: [],
    envExample: {
      ANTHROPIC_API_KEY: 'sk-ant-...',
      TWITTER_API_KEY: 'your-twitter-key',
      LINKEDIN_ACCESS_TOKEN: 'your-linkedin-token',
    },
    outputType: 'document',
    triggerPattern: 'cron',
    estimatedCostUsd: 0.30,
    nodeCount: 4,
    edgeCount: 3,
    featured: true,
  },

  // 5. Code Repository Auditor
  {
    name: 'Code Repository Auditor',
    slug: 'code-repository-auditor',
    description: 'Audits GitHub repositories for security vulnerabilities and code quality',
    longDescription:
      'Automated code auditing for GitHub repositories. The Repo Scanner clones and indexes the codebase, the Security Analyzer checks for known vulnerabilities, dependency issues, and OWASP patterns, and the Report Builder compiles findings into an actionable audit report.',
    category: 'web-development',
    tags: ['github', 'security', 'audit', 'code-quality'],
    version: '1.0.0',
    author: 'AUTOPILATE',
    manifestJson: {
      name: 'Code Repository Auditor',
      slug: 'code-repository-auditor',
      description: 'Audits GitHub repositories for security vulnerabilities and code quality',
      version: '1.0.0',
      category: 'web-development',
      requiredInputs: [
        { name: 'repo_url', type: 'string', description: 'GitHub repository URL to audit', required: true },
        { name: 'branch', type: 'string', description: 'Branch to audit (defaults to main)', required: false },
      ],
      outputType: 'document',
      estimatedCostUsd: 0.20,
      triggerPattern: 'webhook',
      nodeCount: 3,
      edgeCount: 2,
    },
    canvasJson: {
      nodes: [
        node('repo-scanner', 'Repo Scanner', 'scanner', 100, 200),
        node('security-analyzer', 'Security Analyzer', 'analyst', 400, 200),
        node('report-builder', 'Report Builder', 'reporter', 700, 200),
      ],
      edges: [
        edge('repo-scanner', 'security-analyzer'),
        edge('security-analyzer', 'report-builder'),
      ],
    },
    agentConfigs: {
      'repo-scanner': {
        name: 'Repo Scanner',
        role: 'scanner',
        description: 'Clones and indexes the repository structure and dependencies',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are a code repository scanner. Clone the specified repo, analyze the directory structure, identify key files (package.json, requirements.txt, Dockerfile, etc.), and catalog all dependencies with versions.',
        mcps: [],
      },
      'security-analyzer': {
        name: 'Security Analyzer',
        role: 'analyst',
        description: 'Scans for security vulnerabilities and code quality issues',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are a security analysis agent. Review the codebase for: known CVEs in dependencies, hardcoded secrets, SQL injection, XSS, insecure configurations, and OWASP Top 10 patterns. Rate each finding by severity (critical/high/medium/low).',
        mcps: [],
      },
      'report-builder': {
        name: 'Report Builder',
        role: 'reporter',
        description: 'Compiles audit findings into a structured report',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are a security report builder. Compile all findings into a structured audit report with: executive summary, findings sorted by severity, remediation steps, and a risk score. Output in Markdown format.',
        mcps: [],
      },
    },
    mcpConfigs: [],
    envExample: {
      ANTHROPIC_API_KEY: 'sk-ant-...',
      GITHUB_TOKEN: 'ghp_...',
    },
    outputType: 'document',
    triggerPattern: 'webhook',
    estimatedCostUsd: 0.20,
    nodeCount: 3,
    edgeCount: 2,
    featured: false,
  },

  // 6. Research Paper Summarizer
  {
    name: 'Research Paper Summarizer',
    slug: 'research-paper-summarizer',
    description: 'Finds and summarizes recent research papers on a given topic',
    longDescription:
      'Stay current with the latest academic research. The Paper Finder searches arXiv and other databases for recent papers in your field, the Summarizer extracts key findings and methodology from each paper, and the Compiler assembles everything into a structured weekly research digest.',
    category: 'research',
    tags: ['research', 'papers', 'summary', 'academic'],
    version: '1.0.0',
    author: 'AUTOPILATE',
    manifestJson: {
      name: 'Research Paper Summarizer',
      slug: 'research-paper-summarizer',
      description: 'Finds and summarizes recent research papers on a given topic',
      version: '1.0.0',
      category: 'research',
      requiredInputs: [
        { name: 'topic', type: 'string', description: 'Research topic or keywords to search', required: true },
        { name: 'max_papers', type: 'number', description: 'Maximum papers to include (default: 10)', required: false },
      ],
      outputType: 'document',
      estimatedCostUsd: 0.35,
      triggerPattern: 'cron',
      nodeCount: 3,
      edgeCount: 2,
    },
    canvasJson: {
      nodes: [
        node('paper-finder', 'Paper Finder', 'researcher', 100, 200),
        node('summarizer', 'Summarizer', 'analyst', 400, 200),
        node('compiler', 'Compiler', 'writer', 700, 200),
      ],
      edges: [
        edge('paper-finder', 'summarizer'),
        edge('summarizer', 'compiler'),
      ],
    },
    agentConfigs: {
      'paper-finder': {
        name: 'Paper Finder',
        role: 'researcher',
        description: 'Searches academic databases for recent papers on the specified topic',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are an academic research agent. Search arXiv, Semantic Scholar, and other databases for recent papers matching the specified topic. Return title, authors, abstract, publication date, and link for each paper.',
        mcps: [],
      },
      summarizer: {
        name: 'Summarizer',
        role: 'analyst',
        description: 'Reads and summarizes each paper, extracting key findings',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are a research paper summarizer. For each paper, extract: key findings, methodology, main contributions, limitations, and relevance to the specified topic. Keep summaries concise but substantive.',
        mcps: [],
      },
      compiler: {
        name: 'Compiler',
        role: 'writer',
        description: 'Assembles paper summaries into a structured weekly digest',
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: 'You are a research digest compiler. Organize the paper summaries into a coherent weekly digest with: topic overview, key themes across papers, individual summaries, and suggested further reading. Output in Markdown format.',
        mcps: [],
      },
    },
    mcpConfigs: [],
    envExample: {
      ANTHROPIC_API_KEY: 'sk-ant-...',
      SEMANTIC_SCHOLAR_API_KEY: 'your-s2-key',
    },
    outputType: 'document',
    triggerPattern: 'cron',
    estimatedCostUsd: 0.35,
    nodeCount: 3,
    edgeCount: 2,
    featured: false,
  },
];

// ---------------------------------------------------------------------------
// Seed logic
// ---------------------------------------------------------------------------

async function seed(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    console.log(`Connecting to database...`);
    // Quick connectivity check
    await pool.query('SELECT 1');
    console.log('Connected.\n');

    for (const t of templates) {
      console.log(`  Seeding: ${t.name} (${t.slug})`);

      await pool.query(
        `INSERT INTO system_templates (
           name, slug, description, long_description, category, tags, version,
           author, manifest_json, canvas_json, agent_configs, mcp_configs,
           env_example, output_type, trigger_pattern, estimated_cost_usd,
           node_count, edge_count, featured, status, published_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6::text[], $7, $8,
           $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
           $13::jsonb, $14, $15, $16, $17, $18, $19, 'published', NOW()
         )
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           long_description = EXCLUDED.long_description,
           category = EXCLUDED.category,
           tags = EXCLUDED.tags,
           version = EXCLUDED.version,
           manifest_json = EXCLUDED.manifest_json,
           canvas_json = EXCLUDED.canvas_json,
           agent_configs = EXCLUDED.agent_configs,
           mcp_configs = EXCLUDED.mcp_configs,
           env_example = EXCLUDED.env_example,
           output_type = EXCLUDED.output_type,
           trigger_pattern = EXCLUDED.trigger_pattern,
           estimated_cost_usd = EXCLUDED.estimated_cost_usd,
           node_count = EXCLUDED.node_count,
           edge_count = EXCLUDED.edge_count,
           featured = EXCLUDED.featured,
           status = 'published',
           published_at = NOW(),
           updated_at = NOW()`,
        [
          t.name,
          t.slug,
          t.description,
          t.longDescription,
          t.category,
          t.tags,
          t.version,
          t.author,
          JSON.stringify(t.manifestJson),
          JSON.stringify(t.canvasJson),
          JSON.stringify(t.agentConfigs),
          JSON.stringify(t.mcpConfigs),
          JSON.stringify(t.envExample),
          t.outputType,
          t.triggerPattern,
          t.estimatedCostUsd,
          t.nodeCount,
          t.edgeCount,
          t.featured,
        ]
      );
    }

    // Verify
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM system_templates WHERE status = 'published'`
    );
    const total = parseInt(rows[0].count, 10);

    const { rows: featuredRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM system_templates WHERE featured = true`
    );
    const featuredCount = parseInt(featuredRows[0].count, 10);

    console.log(`\nDone! ${total} published templates in database (${featuredCount} featured).`);
  } finally {
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
