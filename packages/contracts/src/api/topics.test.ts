import { describe, expect, it } from 'vitest';

import {
  AdoptTopicRequestSchema,
  TopicCandidateOutputSchema,
  TopicPlanRequestSchema,
} from './topics.js';

const keywordId = '0b44bf0c-8c9a-44b9-9a19-a1812f5695fb';
const evidenceId = '1b44bf0c-8c9a-44b9-9a19-a1812f5695fb';

const suggestion = {
  audience: 'Enterprise marketing and content leaders',
  constraints: {},
  due_at: null,
  keyword_ids: [keywordId],
  objective: 'education' as const,
  primary_keyword_id: keywordId,
  title: 'How enterprise teams can operationalize GEO',
};

describe('topic API contracts', () => {
  it('accepts a fully evidenced topic and applies Brief constraint defaults', () => {
    const result = TopicCandidateOutputSchema.parse({
      brief_suggestion: suggestion,
      entities: ['GEO', 'Enterprise content'],
      evidence_ids: [evidenceId],
      intent: 'informational',
      platform_codes: ['official_site', 'zhihu'],
      priority: 90,
      question: 'How should enterprise teams operationalize GEO content?',
      risk_level: 'low',
    });
    expect(result.brief_suggestion.constraints).toEqual({
      additional_instructions: null,
      cta: null,
      schema_version: 'brief-constraints@1',
    });
  });

  it('requires high risk for evidence-free topics and a valid primary keyword', () => {
    const base = {
      brief_suggestion: suggestion,
      entities: ['GEO'],
      evidence_ids: [],
      intent: 'informational',
      platform_codes: ['official_site'],
      priority: 70,
      question: 'What GEO trend should an enterprise monitor next?',
    };
    expect(TopicCandidateOutputSchema.safeParse({ ...base, risk_level: 'medium' }).success).toBe(
      false,
    );
    expect(TopicCandidateOutputSchema.safeParse({ ...base, risk_level: 'high' }).success).toBe(
      true,
    );
    expect(
      TopicCandidateOutputSchema.safeParse({
        ...base,
        brief_suggestion: { ...suggestion, keyword_ids: [evidenceId] },
        risk_level: 'high',
      }).success,
    ).toBe(false);
  });

  it('validates generation scope and human adoption overrides strictly', () => {
    expect(
      TopicPlanRequestSchema.safeParse({
        keyword_set_ids: [keywordId],
        platform_codes: ['official_site', 'official_site'],
        project_id: keywordId,
        workspace_id: evidenceId,
      }).success,
    ).toBe(false);
    expect(AdoptTopicRequestSchema.safeParse({ title: 'Human-approved title' }).success).toBe(true);
    expect(AdoptTopicRequestSchema.safeParse({ unknown: true }).success).toBe(false);
  });
});
