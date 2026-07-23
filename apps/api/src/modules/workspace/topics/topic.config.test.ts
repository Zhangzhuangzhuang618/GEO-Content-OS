import { describe, expect, it } from 'vitest';

import { readTopicPlannerConfiguration } from './topic.config.js';

describe('topic planner configuration', () => {
  it('uses mock-safe local defaults and rejects production omissions', () => {
    expect(readTopicPlannerConfiguration({})).toEqual({
      modelKey: 'mock-topic-planner',
      promptVersionId: '00000000-0000-4000-8000-000000000026',
      skillVersion: '1.0.0',
    });
    expect(() => readTopicPlannerConfiguration({ NODE_ENV: 'production' })).toThrow(
      'TOPIC_PLANNER_MODEL_KEY is required',
    );
  });

  it('validates injected model, prompt, and skill identifiers', () => {
    expect(
      readTopicPlannerConfiguration({
        NODE_ENV: 'production',
        TOPIC_PLANNER_MODEL_KEY: 'deepseek/topic-pro',
        TOPIC_PLANNER_PROMPT_VERSION_ID: '10000000-0000-4000-8000-000000000026',
        TOPIC_PLANNER_SKILL_VERSION: '1.2.3',
      }),
    ).toMatchObject({ modelKey: 'deepseek/topic-pro', skillVersion: '1.2.3' });
    expect(() => readTopicPlannerConfiguration({ TOPIC_PLANNER_SKILL_VERSION: 'latest' })).toThrow(
      'semantic version',
    );
  });
});
