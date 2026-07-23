import { describe, expect, it } from 'vitest';

import { TopicPlannerDataSchema as PersistedTopicPlannerDataSchema } from '../../api/topics.js';
import { TOPIC_PLANNER_CONTRACT_V1 } from '../../../../skills/topic-planner/contracts/v1.0.0/index.js';
import { SchemaGuard } from '../../../../skills/runtime/schema-guard.js';
import { GET_STRATEGY_VERSION_TOOL, SEARCH_KNOWLEDGE_TOOL } from '../tool-definitions.js';
import {
  TOPIC_PLANNER_DATA_SCHEMA,
  TOPIC_PLANNER_INPUT_SCHEMA,
  TOPIC_PLANNER_OUTPUT_SCHEMA,
} from './topic-planner.schemas.js';

const guard = new SchemaGuard();

describe('topic-planner contract v1.0.0', () => {
  it('keeps all versioned few-shot inputs and outputs schema-valid', () => {
    for (const fixture of TOPIC_PLANNER_CONTRACT_V1.fewShots) {
      expect(guard.check(TOPIC_PLANNER_INPUT_SCHEMA, fixture.input), fixture.id).toMatchObject({
        valid: true,
      });
      expect(guard.check(TOPIC_PLANNER_DATA_SCHEMA, fixture.output.data), fixture.id).toMatchObject(
        {
          valid: true,
        },
      );
      expect(guard.check(TOPIC_PLANNER_OUTPUT_SCHEMA, fixture.output), fixture.id).toMatchObject({
        valid: true,
      });
      expect(PersistedTopicPlannerDataSchema.safeParse(fixture.output.data).success).toBe(true);
    }
  });

  it('allows only published strategy lookup and scoped knowledge search', () => {
    expect(TOPIC_PLANNER_CONTRACT_V1.toolNames).toEqual([
      'get_strategy_version',
      'search_knowledge',
    ]);
    expect(JSON.stringify([GET_STRATEGY_VERSION_TOOL, SEARCH_KNOWLEDGE_TOOL])).not.toContain(
      'tenant_id',
    );
  });

  it('requires high or critical risk for evidence-free topics', () => {
    const evidenced = TOPIC_PLANNER_CONTRACT_V1.fewShots[0]!.output.data.topics[0]!;
    const evidenceFree = TOPIC_PLANNER_CONTRACT_V1.fewShots[1]!.output.data.topics[0]!;
    expect(
      guard.check(TOPIC_PLANNER_DATA_SCHEMA, {
        topics: [{ ...evidenceFree, risk_level: 'medium' }],
      }),
    ).toMatchObject({ valid: false });
    expect(
      guard.check(TOPIC_PLANNER_DATA_SCHEMA, {
        topics: [{ ...evidenced, evidence_ids: [] }],
      }),
    ).toMatchObject({ valid: false });
  });

  it('uses only evidence IDs returned by the knowledge tool', () => {
    for (const fixture of TOPIC_PLANNER_CONTRACT_V1.fewShots) {
      const returnedIds = new Set(fixture.toolResults.map((result) => result['chunk_id']));
      for (const topic of fixture.output.data.topics) {
        for (const evidenceId of topic.evidence_ids) expect(returnedIds.has(evidenceId)).toBe(true);
      }
    }
  });

  it('keeps proposed platforms within the requested platform scope', () => {
    for (const fixture of TOPIC_PLANNER_CONTRACT_V1.fewShots) {
      const requested = new Set(fixture.input['platform_scope'] as readonly string[]);
      for (const topic of fixture.output.data.topics) {
        for (const platform of topic.platform_codes) expect(requested.has(platform)).toBe(true);
      }
    }
  });

  it('does not accept tenant scope or workflow adoption fields from the model', () => {
    const fixture = TOPIC_PLANNER_CONTRACT_V1.fewShots[0]!;
    expect(
      guard.check(TOPIC_PLANNER_INPUT_SCHEMA, { ...fixture.input, tenant_id: 'untrusted' }),
    ).toMatchObject({ valid: false });
    expect(
      guard.check(TOPIC_PLANNER_DATA_SCHEMA, {
        topics: [{ ...fixture.output.data.topics[0], status: 'adopted' }],
      }),
    ).toMatchObject({ valid: false });
  });
});
