import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = readFileSync(new URL('./deploy-windows.ps1', import.meta.url), 'utf8');

test('provisions the Douyin gateway without replacing an existing token', () => {
  assert.match(
    script,
    /if \(-not \(Get-EnvValue "DOUYIN_BROWSER_GATEWAY_TOKEN"\)\) \{\s*Set-EnvValue "DOUYIN_BROWSER_GATEWAY_TOKEN" \(New-RandomHex 32\)\s*\}/u,
  );
  assert.doesNotMatch(script, /Write-(?:Host|Output).*DOUYIN_BROWSER_GATEWAY_TOKEN/iu);
});

test('starts and waits for the Douyin browser worker', () => {
  const services = readQuotedArray('$Services');
  const healthServices = readQuotedArray('foreach ($Service in @');

  assert.equal(services.filter((service) => service === 'douyin-browser').length, 1);
  assert.equal(healthServices.filter((service) => service === 'douyin-browser').length, 1);
});

test('runs the demo seed only when SkipSeed is absent', () => {
  assert.match(script, /\[switch\]\$SkipSeed/u);
  const seedCommand =
    'Invoke-Docker ($ComposePrefix + @("exec", "-T", "api", "node", "apps/api/dist/database/seeds/cli.js"))';
  const seedBlock = script.match(/if \(-not \$SkipSeed\) \{([\s\S]*?)\r?\n\}/u)?.[1] ?? '';

  assert.equal(script.split(seedCommand).length - 1, 1);
  assert.ok(seedBlock.includes(seedCommand));
});

test('uses the optional production Compose override for every deployment command', () => {
  assert.match(script, /\$ComposeFileArguments = @\("-f", \$ComposePath\)/u);
  assert.match(
    script,
    /if \(Test-Path \$ComposeOverridePath\) \{\s*\$ComposeFileArguments \+= @\("-f", \$ComposeOverridePath\)\s*\}/u,
  );
  assert.equal(script.match(/\+ \$ComposeFileArguments/gu)?.length, 3);
});

function readQuotedArray(startMarker) {
  const start = script.indexOf(startMarker);
  assert.notEqual(start, -1, `missing array marker: ${startMarker}`);
  const open = script.indexOf('@(', start);
  const close = script.indexOf(')', open);
  assert.notEqual(open, -1, `missing array start: ${startMarker}`);
  assert.notEqual(close, -1, `missing array end: ${startMarker}`);
  return [...script.slice(open, close).matchAll(/"([a-z0-9-]+)"/gu)].map((match) => match[1]);
}
