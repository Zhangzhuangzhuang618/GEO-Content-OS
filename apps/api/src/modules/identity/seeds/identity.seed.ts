import type { DatabaseClient } from '../../../database/index.js';

export const IDENTITY_SEED = Object.freeze({
  membershipId: '21000000-0000-4000-8000-000000000001',
  tenantId: '20000000-0000-4000-8000-000000000001',
  userId: '10000000-0000-4000-8000-000000000001',
});

export async function seedIdentity(client: DatabaseClient): Promise<void> {
  await client.begin(async (transaction) => {
    await transaction`
      INSERT INTO users (id, email, password_hash, display_name, status)
      VALUES (
        ${IDENTITY_SEED.userId},
        'owner@example.com',
        NULL,
        '示例Owner',
        'invited'
      )
      ON CONFLICT (id) DO NOTHING
    `;
    await transaction`
      INSERT INTO tenants (id, name, slug, plan_code, timezone, status)
      VALUES (
        ${IDENTITY_SEED.tenantId},
        '示例科技',
        'demo-tech',
        'growth',
        'Asia/Shanghai',
        'active'
      )
      ON CONFLICT (id) DO NOTHING
    `;
    await transaction`
      INSERT INTO memberships (id, tenant_id, user_id, role_code, status)
      VALUES (
        ${IDENTITY_SEED.membershipId},
        ${IDENTITY_SEED.tenantId},
        ${IDENTITY_SEED.userId},
        'tenant_owner',
        'active'
      )
      ON CONFLICT (id) DO NOTHING
    `;

    const [user] = await transaction<
      { displayName: string; email: string; passwordHash: string | null; status: string }[]
    >`
      SELECT
        display_name AS "displayName",
        email::text AS email,
        password_hash AS "passwordHash",
        status
      FROM users
      WHERE id = ${IDENTITY_SEED.userId}
    `;
    const [tenant] = await transaction<
      { name: string; planCode: string; slug: string; status: string; timezone: string }[]
    >`
      SELECT
        name,
        plan_code AS "planCode",
        slug::text AS slug,
        status,
        timezone
      FROM tenants
      WHERE id = ${IDENTITY_SEED.tenantId}
    `;
    const [membership] = await transaction<
      { roleCode: string; status: string; tenantId: string; userId: string }[]
    >`
      SELECT
        tenant_id AS "tenantId",
        user_id AS "userId",
        role_code AS "roleCode",
        status
      FROM memberships
      WHERE id = ${IDENTITY_SEED.membershipId}
    `;

    if (
      !user ||
      user.displayName !== '示例Owner' ||
      user.email !== 'owner@example.com' ||
      user.passwordHash !== null ||
      user.status !== 'invited' ||
      !tenant ||
      tenant.name !== '示例科技' ||
      tenant.planCode !== 'growth' ||
      tenant.slug !== 'demo-tech' ||
      tenant.status !== 'active' ||
      tenant.timezone !== 'Asia/Shanghai' ||
      !membership ||
      membership.tenantId !== IDENTITY_SEED.tenantId ||
      membership.userId !== IDENTITY_SEED.userId ||
      membership.roleCode !== 'tenant_owner' ||
      membership.status !== 'active'
    ) {
      throw new Error('Identity seed conflicts with existing rows');
    }
  });
}
