import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

import { validateRollout } from './validate.mjs';

const manifest = JSON.parse(
  readFileSync(new URL('./platform-rollout.v1.json', import.meta.url), 'utf8'),
);

test('accepts the fail-closed two-phase seven-platform rollout', () => {
  assert.deepEqual(validateRollout(manifest), []);
});

test('rejects enabling a platform before an approved rollout', () => {
  const changed = clone(manifest);
  changed.flags[0].enabled = true;
  assert.match(validateRollout(changed).join('\n'), /disabled phase-1 flag/u);
});

test('rejects moving a phase-2 platform into the first phase', () => {
  const changed = clone(manifest);
  changed.phases[0].platforms.push('douyin');
  assert.match(validateRollout(changed).join('\n'), /rollout order/u);
});

test('rejects duplicate environment variables and unsupported fields', () => {
  const changed = clone(manifest);
  changed.flags[1].environment_variable = changed.flags[0].environment_variable;
  changed.flags[1].future_option = true;
  assert.match(validateRollout(changed).join('\n'), /unique feature flag/u);
  assert.match(validateRollout(changed).join('\n'), /unsupported fields/u);
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
