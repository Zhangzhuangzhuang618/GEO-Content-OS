import { OFFICIAL_SITE_RENDER_RULE_VERSION } from './types.js';

export const OFFICIAL_SITE_RENDER_RULES_V1 = Object.freeze({
  body: Object.freeze({ maximumCharacters: 2_500, minimumCharacters: 800 }),
  platformCode: 'official_site',
  requiredPlatformMeta: Object.freeze(['slug', 'meta_description', 'faq', 'schema_org']),
  requiredStructure: Object.freeze([
    'h2',
    'faq',
    'first_paragraph',
    'structured_entities',
    'citation_links',
  ]),
  title: Object.freeze({ maximumCharacters: 60, minimumCharacters: 20 }),
  version: OFFICIAL_SITE_RENDER_RULE_VERSION,
});
