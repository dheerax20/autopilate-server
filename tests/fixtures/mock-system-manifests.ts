import type { SystemManifest } from '../../types/registry';

export const webDesignManifest: SystemManifest = {
  name: 'Web Design Studio',
  slug: 'web-design-studio',
  description:
    'Designs and builds responsive landing pages and websites. Takes business requirements and produces polished HTML/CSS/JS artifacts.',
  version: '1.2.0',
  category: 'web-development',
  requiredInputs: [
    {
      name: 'business_name',
      type: 'string',
      description: 'The name of the business or project',
      required: true,
    },
    {
      name: 'target_audience',
      type: 'string',
      description: 'Who the website is aimed at',
      required: true,
    },
    {
      name: 'page_type',
      type: 'string',
      description: 'Type of page to build (landing, portfolio, e-commerce)',
      required: true,
    },
    {
      name: 'color_scheme',
      type: 'string',
      description: 'Preferred color palette or brand colors',
      required: false,
    },
  ],
  outputType: 'web_artifact',
  estimatedCostUsd: 0.35,
  triggerPattern: 'messaging',
  nodeCount: 5,
  edgeCount: 4,
};

export const contentFactoryManifest: SystemManifest = {
  name: 'Content Factory',
  slug: 'content-factory',
  description:
    'Produces blog posts, articles, and marketing copy on any topic. Handles research, outlining, drafting, and editing.',
  version: '2.0.0',
  category: 'content-production',
  requiredInputs: [
    {
      name: 'topic',
      type: 'string',
      description: 'The subject or topic to write about',
      required: true,
    },
    {
      name: 'format',
      type: 'string',
      description: 'Output format (blog post, article, social media thread)',
      required: true,
    },
    {
      name: 'word_count',
      type: 'number',
      description: 'Target word count for the content',
      required: false,
    },
  ],
  outputType: 'document',
  estimatedCostUsd: 0.15,
  triggerPattern: 'messaging',
  nodeCount: 4,
  edgeCount: 3,
};

export const seoAuditManifest: SystemManifest = {
  name: 'SEO Audit Agent',
  slug: 'seo-audit-agent',
  description:
    'Performs comprehensive SEO audits on websites. Analyzes meta tags, page speed, backlinks, keyword density, and accessibility.',
  version: '1.0.0',
  category: 'research',
  requiredInputs: [
    {
      name: 'url',
      type: 'string',
      description: 'The website URL to audit',
      required: true,
    },
    {
      name: 'competitor_urls',
      type: 'string',
      description: 'Comma-separated list of competitor URLs for comparison',
      required: false,
    },
  ],
  outputType: 'document',
  estimatedCostUsd: 0.25,
  triggerPattern: 'webhook',
  nodeCount: 6,
  edgeCount: 5,
};

export const dataAnalysisManifest: SystemManifest = {
  name: 'Data Analysis Pipeline',
  slug: 'data-analysis-pipeline',
  description:
    'Analyzes CSV and JSON datasets. Generates statistical summaries, visualizations, and insight reports.',
  version: '1.1.0',
  category: 'data-analysis',
  requiredInputs: [
    {
      name: 'dataset_url',
      type: 'string',
      description: 'URL or path to the dataset file',
      required: true,
    },
    {
      name: 'analysis_type',
      type: 'string',
      description: 'Type of analysis (summary, correlation, trend, comparison)',
      required: true,
    },
    {
      name: 'output_format',
      type: 'string',
      description: 'How to present results (charts, tables, narrative)',
      required: false,
    },
  ],
  outputType: 'data',
  estimatedCostUsd: 0.20,
  triggerPattern: 'messaging',
  nodeCount: 4,
  edgeCount: 3,
};

/** All mock manifests for easy use in tests. */
export const allMockManifests: SystemManifest[] = [
  webDesignManifest,
  contentFactoryManifest,
  seoAuditManifest,
  dataAnalysisManifest,
];
