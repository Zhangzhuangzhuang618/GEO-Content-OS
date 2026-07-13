import type { EmailAdapter } from '@geo-content-os/adapter-email';
import type { TenantRoleCode } from '@geo-content-os/contracts';
import { generateSecureToken } from '@geo-content-os/security';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import { AuthService, type LoginContext, type LoginResult } from '../auth/auth.service.js';
import { IdentityAuthDatabase } from '../auth/auth.database.js';
import { PasswordHasher } from '../auth/password-hasher.js';
import { IDENTITY_EMAIL_ADAPTER } from '../email/email.module.js';
import { readInvitationConfiguration, type InvitationConfiguration } from './invitation.config.js';
import type { CreateInvitationRequest, InvitationView } from './invitation.dto.js';
import {
  InvitationAuthenticationError,
  InvitationConflictError,
  InvitationNotFoundError,
  InvitationPermissionError,
} from './invitation.errors.js';

interface InvitationActor {
  readonly displayName: string;
  readonly roleCode: 'tenant_admin' | 'tenant_owner';
  readonly tenantName: string;
}

interface InvitationRow {
  readonly acceptedAt: Date | string | null;
  readonly createdAt: Date | string;
  readonly email: string;
  readonly expiresAt: Date | string;
  readonly id: string;
  readonly invitedBy: string;
  readonly revokedAt: Date | string | null;
  readonly roleCode: TenantRoleCode;
  readonly tenantId: string;
  readonly tenantName?: string;
  readonly workspaceScope: CreateInvitationRequest['workspace_scope'];
}

interface InvitationUser {
  readonly displayName: string;
  readonly email: string;
  readonly id: string;
  readonly passwordHash: string | null;
  readonly status: 'active' | 'disabled' | 'invited';
}

export interface CreateInvitationInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly request: CreateInvitationRequest;
}

export interface AcceptInvitationInput {
  readonly context: LoginContext;
  readonly displayName: string;
  readonly password: string;
  readonly token: string;
}

@Injectable()
export class InvitationService {
  private readonly configuration: InvitationConfiguration;

  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
    @Inject(IDENTITY_EMAIL_ADAPTER) private readonly emailAdapter: EmailAdapter,
  ) {
    this.configuration = readInvitationConfiguration();
  }

  public async create(input: CreateInvitationInput): Promise<InvitationView> {
    const token = generateSecureToken(32);
    const expiresAt = new Date(Date.now() + this.configuration.ttlSeconds * 1_000);
    const result = await this.database.client.begin(async (transaction) => {
      const actor = await findInvitationActor(transaction, input.actorUserId, input.tenantId);
      if (!actor) throw new InvitationPermissionError();
      if (input.request.role_code === 'tenant_owner' && actor.roleCode !== 'tenant_owner') {
        throw new InvitationPermissionError();
      }

      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.tenantId}:${input.request.email}`}, 0))`;
      const memberships = await transaction<{ status: string }[]>`
        SELECT membership.status
        FROM memberships AS membership
        JOIN users AS identity_user ON identity_user.id = membership.user_id
        WHERE
          membership.tenant_id = ${input.tenantId}
          AND identity_user.email = ${input.request.email}
          AND identity_user.deleted_at IS NULL
        LIMIT 1
      `;
      if (memberships.length > 0) throw new InvitationConflictError();

      const existing = await findPendingInvitation(
        transaction,
        input.tenantId,
        input.request.email,
      );
      if (existing && new Date(existing.expiresAt).getTime() <= Date.now()) {
        await transaction`
          UPDATE invitations SET revoked_at = now()
          WHERE id = ${existing.id} AND accepted_at IS NULL AND revoked_at IS NULL
        `;
      } else if (existing) {
        if (
          existing.roleCode !== input.request.role_code ||
          canonicalScope(existing.workspaceScope) !== canonicalScope(input.request.workspace_scope)
        ) {
          throw new InvitationConflictError();
        }
        return { actor, created: false, invitation: existing, token: undefined };
      }

      const [invitation] = await transaction<InvitationRow[]>`
        INSERT INTO invitations (
          tenant_id,
          email,
          role_code,
          workspace_scope_json,
          token_hash,
          expires_at,
          invited_by
        ) VALUES (
          ${input.tenantId},
          ${input.request.email},
          ${input.request.role_code},
          ${JSON.stringify(input.request.workspace_scope)}::text::jsonb,
          ${sha256(token)},
          ${expiresAt.toISOString()},
          ${input.actorUserId}
        )
        RETURNING
          id,
          tenant_id AS "tenantId",
          email::text AS email,
          role_code AS "roleCode",
          workspace_scope_json AS "workspaceScope",
          expires_at AS "expiresAt",
          accepted_at AS "acceptedAt",
          revoked_at AS "revokedAt",
          invited_by AS "invitedBy",
          created_at AS "createdAt"
      `;
      if (!invitation) throw new Error('Invitation insert returned no row');
      return { actor, created: true, invitation, token };
    });

    if (result.created && result.token) {
      try {
        await this.emailAdapter.sendInvitation({
          email: result.invitation.email,
          expiresAt: toIso(result.invitation.expiresAt),
          inviterName: result.actor.displayName,
          tenantName: result.actor.tenantName,
          token: result.token,
        });
      } catch {
        await this.revokeFailedDelivery(result.invitation.id);
        throw new Error('Invitation delivery failed');
      }
    }
    return toInvitationView(result.invitation);
  }

  public async accept(input: AcceptInvitationInput): Promise<LoginResult> {
    const replacementPasswordHash = await this.passwordHasher.hash(input.password);
    return this.database.client.begin(async (transaction) => {
      const [invitation] = await transaction<InvitationRow[]>`
        SELECT
          invitation.id,
          invitation.tenant_id AS "tenantId",
          invitation.email::text AS email,
          invitation.role_code AS "roleCode",
          invitation.workspace_scope_json AS "workspaceScope",
          invitation.expires_at AS "expiresAt",
          invitation.accepted_at AS "acceptedAt",
          invitation.revoked_at AS "revokedAt",
          invitation.invited_by AS "invitedBy",
          invitation.created_at AS "createdAt",
          tenant.name AS "tenantName"
        FROM invitations AS invitation
        JOIN tenants AS tenant ON tenant.id = invitation.tenant_id
        WHERE
          invitation.token_hash = ${sha256(input.token)}
          AND invitation.accepted_at IS NULL
          AND invitation.revoked_at IS NULL
          AND invitation.expires_at > now()
          AND tenant.status = 'active'
          AND tenant.deleted_at IS NULL
        FOR UPDATE OF invitation
      `;
      if (!invitation) throw new InvitationNotFoundError();

      const [existingUser] = await transaction<InvitationUser[]>`
        SELECT
          id,
          email::text AS email,
          display_name AS "displayName",
          password_hash AS "passwordHash",
          status
        FROM users
        WHERE email = ${invitation.email} AND deleted_at IS NULL
        FOR UPDATE
      `;
      let user: InvitationUser;
      if (!existingUser) {
        const [createdUser] = await transaction<InvitationUser[]>`
          INSERT INTO users (email, password_hash, password_changed_at, display_name, status)
          VALUES (${invitation.email}, ${replacementPasswordHash}, now(), ${input.displayName}, 'active')
          RETURNING
            id,
            email::text AS email,
            display_name AS "displayName",
            password_hash AS "passwordHash",
            status
        `;
        if (!createdUser) throw new Error('Invitation user insert returned no row');
        user = createdUser;
      } else if (existingUser.status === 'invited' && existingUser.passwordHash === null) {
        const [activatedUser] = await transaction<InvitationUser[]>`
          UPDATE users
          SET
            password_hash = ${replacementPasswordHash},
            password_changed_at = now(),
            display_name = ${input.displayName},
            status = 'active',
            last_login_at = now()
          WHERE id = ${existingUser.id} AND status = 'invited' AND password_hash IS NULL
          RETURNING
            id,
            email::text AS email,
            display_name AS "displayName",
            password_hash AS "passwordHash",
            status
        `;
        if (!activatedUser) throw new InvitationConflictError();
        user = activatedUser;
      } else if (existingUser.status === 'active' && existingUser.passwordHash) {
        const valid = await this.passwordHasher.verify(existingUser.passwordHash, input.password);
        if (!valid) throw new InvitationAuthenticationError();
        user = existingUser;
        await transaction`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`;
      } else {
        throw new InvitationAuthenticationError();
      }

      const [membership] = await transaction<{ status: string }[]>`
        SELECT status
        FROM memberships
        WHERE tenant_id = ${invitation.tenantId} AND user_id = ${user.id}
        FOR UPDATE
      `;
      if (membership?.status === 'active' || membership?.status === 'disabled') {
        throw new InvitationConflictError();
      }
      if (membership) {
        await transaction`
          UPDATE memberships
          SET role_code = ${invitation.roleCode}, status = 'active'
          WHERE tenant_id = ${invitation.tenantId} AND user_id = ${user.id} AND status = 'invited'
        `;
      } else {
        await transaction`
          INSERT INTO memberships (tenant_id, user_id, role_code, status, invited_by)
          VALUES (
            ${invitation.tenantId},
            ${user.id},
            ${invitation.roleCode},
            'active',
            ${invitation.invitedBy}
          )
        `;
      }
      await transaction`
        UPDATE invitations
        SET accepted_at = now()
        WHERE id = ${invitation.id} AND accepted_at IS NULL AND revoked_at IS NULL
      `;
      return this.authService.issueSessionInTransaction(
        transaction,
        user,
        invitation.tenantId,
        input.context,
      );
    });
  }

  public async revoke(actorUserId: string, tenantId: string, invitationId: string): Promise<void> {
    await this.database.client.begin(async (transaction) => {
      const actor = await findInvitationActor(transaction, actorUserId, tenantId);
      if (!actor) throw new InvitationPermissionError();
      const rows = await transaction<{ id: string }[]>`
        UPDATE invitations
        SET revoked_at = now()
        WHERE
          id = ${invitationId}
          AND tenant_id = ${tenantId}
          AND accepted_at IS NULL
          AND revoked_at IS NULL
        RETURNING id
      `;
      if (rows.length !== 1) throw new InvitationNotFoundError();
    });
  }

  private async revokeFailedDelivery(invitationId: string): Promise<void> {
    await this.database.client`
      UPDATE invitations
      SET revoked_at = now()
      WHERE id = ${invitationId} AND accepted_at IS NULL AND revoked_at IS NULL
    `;
  }
}

async function findInvitationActor(
  transaction: TransactionSql,
  userId: string,
  tenantId: string,
): Promise<InvitationActor | undefined> {
  const rows = await transaction<InvitationActor[]>`
    SELECT
      membership.role_code AS "roleCode",
      identity_user.display_name AS "displayName",
      tenant.name AS "tenantName"
    FROM memberships AS membership
    JOIN users AS identity_user ON identity_user.id = membership.user_id
    JOIN tenants AS tenant ON tenant.id = membership.tenant_id
    WHERE
      membership.user_id = ${userId}
      AND membership.tenant_id = ${tenantId}
      AND membership.status = 'active'
      AND membership.role_code IN ('tenant_owner', 'tenant_admin')
      AND identity_user.status = 'active'
      AND identity_user.deleted_at IS NULL
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0];
}

async function findPendingInvitation(
  transaction: TransactionSql,
  tenantId: string,
  email: string,
): Promise<InvitationRow | undefined> {
  const rows = await transaction<InvitationRow[]>`
    SELECT
      id,
      tenant_id AS "tenantId",
      email::text AS email,
      role_code AS "roleCode",
      workspace_scope_json AS "workspaceScope",
      expires_at AS "expiresAt",
      accepted_at AS "acceptedAt",
      revoked_at AS "revokedAt",
      invited_by AS "invitedBy",
      created_at AS "createdAt"
    FROM invitations
    WHERE
      tenant_id = ${tenantId}
      AND email = ${email}
      AND accepted_at IS NULL
      AND revoked_at IS NULL
    FOR UPDATE
  `;
  return rows[0];
}

function toInvitationView(invitation: InvitationRow): InvitationView {
  const now = Date.now();
  return {
    created_at: toIso(invitation.createdAt),
    email: invitation.email,
    expires_at: toIso(invitation.expiresAt),
    id: invitation.id,
    role_code: invitation.roleCode,
    status: invitation.acceptedAt
      ? 'accepted'
      : invitation.revokedAt
        ? 'revoked'
        : new Date(invitation.expiresAt).getTime() <= now
          ? 'expired'
          : 'pending',
    tenant_id: invitation.tenantId,
    workspace_scope: invitation.workspaceScope,
  };
}

function canonicalScope(value: CreateInvitationRequest['workspace_scope']): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}
