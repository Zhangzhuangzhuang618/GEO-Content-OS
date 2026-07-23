import { createRequire } from 'node:module';

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { argon2id, hash } = requireFromApi('argon2');
const postgres = requireFromApi('postgres');

const ARGON2ID_OPTIONS = Object.freeze({
  memoryCost: 19_456,
  parallelism: 1,
  timeCost: 2,
  type: argon2id,
});

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) fail('DATABASE_URL is required');

const input = parseInput(await readStandardInput());
const passwordHash = await hash(input.password, ARGON2ID_OPTIONS);
const client = postgres(databaseUrl, { max: 1, prepare: false });

try {
  const result = await client.begin(async (transaction) => {
    const tenants = await transaction`
      SELECT id
      FROM tenants
      WHERE
        slug = ${input.tenantSlug}::citext
        AND status = 'active'
        AND deleted_at IS NULL
      LIMIT 2
      FOR SHARE
    `;
    if (tenants.length !== 1) {
      throw new Error(`Active tenant ${input.tenantSlug} was not found`);
    }
    const tenantId = tenants[0].id;
    const users = await transaction`
      INSERT INTO users (
        email, password_hash, password_changed_at, display_name, status
      ) VALUES (
        ${input.email}::citext,
        ${passwordHash},
        now(),
        ${input.displayName},
        'active'
      )
      ON CONFLICT (email) WHERE deleted_at IS NULL
      DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        password_changed_at = now(),
        display_name = EXCLUDED.display_name,
        status = 'active'
      RETURNING id
    `;
    const userId = users[0].id;
    await transaction`
      INSERT INTO memberships (
        tenant_id, user_id, role_code, status
      ) VALUES (
        ${tenantId},
        ${userId},
        'tenant_owner',
        'active'
      )
      ON CONFLICT (tenant_id, user_id)
      DO UPDATE SET
        role_code = 'tenant_owner',
        status = 'active',
        version = memberships.version + 1
    `;
    await transaction`
      UPDATE sessions
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE user_id = ${userId} AND revoked_at IS NULL
    `;
    return { tenantId, userId };
  });
  process.stdout.write(
    `${JSON.stringify({
      email: input.email,
      role: 'tenant_owner',
      status: 'active',
      tenant_id: result.tenantId,
      user_id: result.userId,
    })}\n`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : 'Owner bootstrap failed');
} finally {
  await client.end({ timeout: 5 });
}

async function readStandardInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 8_192) fail('Bootstrap input is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseInput(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail('Bootstrap input must be JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Bootstrap input must be a JSON object');
  }
  const email = requiredString(value.email, 'email').toLowerCase();
  const displayName = requiredString(value.display_name, 'display_name');
  const password = requiredPassword(value.password);
  const tenantSlug = requiredString(value.tenant_slug ?? 'demo-tech', 'tenant_slug').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254) {
    fail('email is invalid');
  }
  if ([...displayName].length > 80) fail('display_name must contain at most 80 characters');
  const passwordLength = [...password].length;
  if (
    passwordLength < 12 ||
    passwordLength > 128 ||
    [...password].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || codePoint <= 31 || codePoint === 127;
    })
  ) {
    fail('password must contain 12 to 128 non-control characters');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(tenantSlug)) {
    fail('tenant_slug is invalid');
  }
  return Object.freeze({ displayName, email, password, tenantSlug });
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} is required`);
  return value.trim();
}

function requiredPassword(value) {
  if (typeof value !== 'string' || value.length === 0) fail('password is required');
  return value;
}

function fail(message) {
  console.error(`Owner bootstrap failed: ${message}`);
  process.exit(1);
}
