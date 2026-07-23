export interface TopicPlannerConfiguration {
  readonly modelKey: string;
  readonly promptVersionId: string;
  readonly skillVersion: string;
}

const DEVELOPMENT_DEFAULTS: TopicPlannerConfiguration = {
  modelKey: 'mock-topic-planner',
  promptVersionId: '00000000-0000-4000-8000-000000000026',
  skillVersion: '1.0.0',
};

export function readTopicPlannerConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): TopicPlannerConfiguration {
  const production = environment['NODE_ENV'] === 'production';
  const modelKey = readValue(environment, 'TOPIC_PLANNER_MODEL_KEY', production);
  const promptVersionId = readValue(environment, 'TOPIC_PLANNER_PROMPT_VERSION_ID', production);
  const skillVersion = readValue(environment, 'TOPIC_PLANNER_SKILL_VERSION', production);
  const configuration = {
    modelKey: modelKey ?? DEVELOPMENT_DEFAULTS.modelKey,
    promptVersionId: promptVersionId ?? DEVELOPMENT_DEFAULTS.promptVersionId,
    skillVersion: skillVersion ?? DEVELOPMENT_DEFAULTS.skillVersion,
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/u.test(configuration.modelKey)) {
    throw new Error('TOPIC_PLANNER_MODEL_KEY must be a valid model configuration key');
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      configuration.promptVersionId,
    )
  ) {
    throw new Error('TOPIC_PLANNER_PROMPT_VERSION_ID must be a UUID');
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(configuration.skillVersion)) {
    throw new Error('TOPIC_PLANNER_SKILL_VERSION must be semantic version');
  }
  return configuration;
}

function readValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  required: boolean,
): string | undefined {
  const value = environment[name]?.trim();
  if (!value && required) throw new Error(`${name} is required in production`);
  return value || undefined;
}
