import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const manifestPath = fileURLToPath(new URL('./platform-rollout.v1.json', import.meta.url));

export function validateRollout(value) {
  const errors = [];
  if (!record(value)) return ['rollout manifest must be an object'];
  exactKeys(
    value,
    [
      'default_enabled',
      'environment',
      'flags',
      'gates',
      'kill_switch',
      'phases',
      'release',
      'schema_version',
    ],
    'rollout manifest',
    errors,
  );
  if (value.schema_version !== 'platform-rollout@1') errors.push('schema_version must be fixed');
  if (value.release !== 'v2.1') errors.push('release must be v2.1');
  if (value.environment !== 'production') errors.push('environment must be production');
  if (value.default_enabled !== false) errors.push('default_enabled must be false');
  if (
    !record(value.kill_switch) ||
    !exactKeys(value.kill_switch, ['environment_variable', 'safe_value'], 'kill switch', errors) ||
    value.kill_switch.environment_variable !== 'GEO_PUBLISHING_KILL_SWITCH' ||
    value.kill_switch.safe_value !== 'true'
  ) {
    errors.push('the fail-closed global publishing kill switch is required');
  }

  const expectedGates = {
    accessibility_serious_or_critical_max: 0,
    api_p95_ms_max: 800,
    cost_regression_percent_max: 15,
    queue_enqueue_p95_ms_max: 2_000,
    request_failure_rate_max: 0.01,
    rpo_seconds_max: 900,
    rto_seconds_max: 3_600,
    security_blockers_max: 0,
  };
  if (
    !record(value.gates) ||
    !exactKeys(value.gates, Object.keys(expectedGates), 'release gates', errors) ||
    Object.keys(expectedGates).some((key) => value.gates[key] !== expectedGates[key])
  ) {
    errors.push('release thresholds must match the frozen gates');
  }

  const phases = Array.isArray(value.phases) ? value.phases : [];
  const first = phases[0];
  const second = phases[1];
  const firstPlatforms = ['official_site', 'zhihu', 'xiaohongshu'];
  const secondPlatforms = ['baijiahao', 'toutiao', 'wechat_mp', 'douyin'];
  if (
    phases.length !== 2 ||
    !phaseMatches(first, 'phase-1', null, firstPlatforms) ||
    !phaseMatches(second, 'phase-2', 'phase-1', secondPlatforms)
  ) {
    errors.push('rollout order must be phase-1 then phase-2 with the frozen platform groups');
  }

  const flags = Array.isArray(value.flags) ? value.flags : [];
  const expectedPlatforms = [...firstPlatforms, ...secondPlatforms];
  const environmentVariables = flags.map((flag) =>
    record(flag) ? flag.environment_variable : undefined,
  );
  if (
    flags.length !== expectedPlatforms.length ||
    new Set(flags.map((flag) => (record(flag) ? flag.platform : undefined))).size !==
      expectedPlatforms.length ||
    new Set(environmentVariables).size !== expectedPlatforms.length
  ) {
    errors.push('each MVP platform requires one unique feature flag and environment variable');
  }
  for (const platform of expectedPlatforms) {
    const flag = flags.find((candidate) => record(candidate) && candidate.platform === platform);
    const expectedPhase = firstPlatforms.includes(platform) ? 'phase-1' : 'phase-2';
    const expectedEnvironmentVariable = `GEO_PUBLISH_${platform.toUpperCase()}_ENABLED`;
    if (
      !record(flag) ||
      !exactKeys(
        flag,
        ['enabled', 'environment_variable', 'key', 'phase', 'platform'],
        `platform ${platform} flag`,
        errors,
      ) ||
      flag.enabled !== false ||
      flag.phase !== expectedPhase ||
      flag.key !== `publishing.${platform}` ||
      flag.environment_variable !== expectedEnvironmentVariable
    ) {
      errors.push(`platform ${platform} must have one disabled ${expectedPhase} flag`);
    }
  }
  return errors;
}

function phaseMatches(value, id, previous, platforms) {
  return (
    record(value) &&
    exactKeys(value, ['id', 'platforms', 'requires_previous_phase']) &&
    value.id === id &&
    value.requires_previous_phase === previous &&
    Array.isArray(value.platforms) &&
    value.platforms.length === platforms.length &&
    value.platforms.every((platform, index) => platform === platforms[index])
  );
}

function exactKeys(value, expected, label = 'object', errors) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const matches =
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
  if (!matches && errors) errors.push(`${label} contains missing or unsupported fields`);
  return matches;
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const errors = validateRollout(manifest);
  if (errors.length > 0) {
    process.stderr.write(
      `[FEATURE_FLAGS_INVALID]\n${errors.map((error) => `- ${error}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('[FEATURE_FLAGS_VALID] Seven platform flags are disabled and phased.\n');
  }
}
