import { constantTimeEqual, generateSecureToken, isValidCsrfToken } from '@geo-content-os/security';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { IdentityRepository } from '../repositories/identity.repository.js';
import { readAuthConfiguration, type AuthConfiguration } from './auth.config.js';
import { IdentityAuthDatabase } from './auth.database.js';
import type { LoginRequest, SessionView } from './auth.dto.js';
import { PasswordHasher } from './password-hasher.js';

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;

interface SessionDatabaseView {
  readonly activeTenantId: string | null;
  readonly csrfHash: string;
  readonly displayName: string;
  readonly email: string;
  readonly expiresAt: Date | string;
  readonly id: string;
  readonly userId: string;
}

export interface LoginContext {
  readonly ip?: string;
  readonly userAgent?: string;
}

export interface AuthenticatedSession {
  readonly csrfToken?: string;
  readonly view: SessionView;
}

export interface LoginResult extends AuthenticatedSession {
  readonly csrfToken: string;
  readonly sessionToken: string;
  readonly ttlSeconds: number;
}

export interface AuthSessionPrincipal {
  readonly activeTenantId: string | null;
  readonly sessionId: string;
  readonly userId: string;
}

export interface SessionIdentity {
  readonly displayName: string;
  readonly email: string;
  readonly id: string;
}

@Injectable()
export class AuthService {
  private readonly configuration: AuthConfiguration;

  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
  ) {
    this.configuration = readAuthConfiguration();
  }

  public get preAuthCsrfTtlSeconds(): number {
    return this.configuration.preAuthCsrfTtlSeconds;
  }

  public async login(input: LoginRequest, context: LoginContext): Promise<LoginResult | undefined> {
    const client = this.database.client;
    const repository = new IdentityRepository(client);
    const user = await repository.findAuthenticationUserByEmail(input.email);
    const passwordValid = await this.passwordHasher.verify(user?.passwordHash, input.password);

    if (!user || !passwordValid || user.status !== 'active') return undefined;

    const ttlSeconds = input.remember_me
      ? this.configuration.rememberSessionTtlSeconds
      : this.configuration.sessionTtlSeconds;
    return client.begin(async (transaction) => {
      const activeUsers = await transaction<{ id: string }[]>`
        UPDATE users
        SET last_login_at = now()
        WHERE
          id = ${user.id}
          AND status = 'active'
          AND deleted_at IS NULL
          AND password_hash IS NOT NULL
        RETURNING id
      `;
      if (activeUsers.length !== 1) return undefined;
      return this.issueSessionInTransaction(transaction, user, null, context, ttlSeconds);
    });
  }

  public async issueSessionInTransaction(
    transaction: postgres.TransactionSql,
    user: SessionIdentity,
    activeTenantId: string | null,
    context: LoginContext,
    ttlSeconds = this.configuration.sessionTtlSeconds,
  ): Promise<LoginResult> {
    const sessionToken = generateSecureToken(32);
    const csrfToken = generateSecureToken(32);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
    await transaction`
      INSERT INTO sessions (
        user_id,
        active_tenant_id,
        session_hash,
        csrf_hash,
        expires_at,
        ip,
        user_agent
      ) VALUES (
        ${user.id},
        ${activeTenantId},
        ${sha256(sessionToken)},
        ${sha256(csrfToken)},
        ${expiresAt.toISOString()},
        ${context.ip ?? null},
        ${context.userAgent?.slice(0, 2_048) ?? null}
      )
    `;
    return {
      csrfToken,
      sessionToken,
      ttlSeconds,
      view: toSessionView({
        activeTenantId,
        csrfHash: sha256(csrfToken),
        displayName: user.displayName,
        email: user.email,
        expiresAt,
        id: '',
        userId: user.id,
      }),
    };
  }

  public async getSession(
    sessionToken: string | undefined,
    csrfToken: string | undefined,
  ): Promise<AuthenticatedSession | undefined> {
    if (!isValidSessionToken(sessionToken)) return undefined;
    const session = await this.findAndTouchSession(sha256(sessionToken));
    if (!session) return undefined;

    if (isValidCsrfToken(csrfToken) && constantTimeEqual(session.csrfHash, sha256(csrfToken))) {
      return { view: toSessionView(session) };
    }

    const rotatedCsrfToken = generateSecureToken(32);
    const rows = await this.database.client<{ id: string }[]>`
      UPDATE sessions
      SET csrf_hash = ${sha256(rotatedCsrfToken)}
      WHERE id = ${session.id} AND revoked_at IS NULL AND expires_at > now()
      RETURNING id
    `;
    if (rows.length !== 1) return undefined;
    return { csrfToken: rotatedCsrfToken, view: toSessionView(session) };
  }

  public async logout(
    sessionToken: string | undefined,
    csrfToken: string | undefined,
  ): Promise<boolean> {
    if (!isValidSessionToken(sessionToken) || !isValidCsrfToken(csrfToken)) return false;
    const rows = await this.database.client<{ id: string }[]>`
      UPDATE sessions AS session
      SET revoked_at = now()
      FROM users AS identity_user
      WHERE
        session.session_hash = ${sha256(sessionToken)}
        AND session.csrf_hash = ${sha256(csrfToken)}
        AND session.user_id = identity_user.id
        AND session.revoked_at IS NULL
        AND session.expires_at > now()
        AND identity_user.status = 'active'
        AND identity_user.deleted_at IS NULL
        AND (
          session.active_tenant_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM memberships AS membership
            JOIN tenants AS tenant ON tenant.id = membership.tenant_id
            WHERE
              membership.user_id = session.user_id
              AND membership.tenant_id = session.active_tenant_id
              AND membership.status = 'active'
              AND tenant.status = 'active'
              AND tenant.deleted_at IS NULL
          )
        )
      RETURNING session.id
    `;
    return rows.length === 1;
  }

  public async authenticateWriteSession(
    sessionToken: string | undefined,
    csrfToken: string | undefined,
  ): Promise<AuthSessionPrincipal | undefined> {
    if (!isValidSessionToken(sessionToken) || !isValidCsrfToken(csrfToken)) return undefined;
    const session = await this.findAndTouchSession(sha256(sessionToken));
    if (!session || !constantTimeEqual(session.csrfHash, sha256(csrfToken))) return undefined;
    return {
      activeTenantId: session.activeTenantId,
      sessionId: session.id,
      userId: session.userId,
    };
  }

  private async findAndTouchSession(sessionHash: string): Promise<SessionDatabaseView | undefined> {
    const rows = await this.database.client<SessionDatabaseView[]>`
      UPDATE sessions AS session
      SET last_seen_at = now()
      FROM users AS identity_user
      WHERE
        session.session_hash = ${sessionHash}
        AND session.user_id = identity_user.id
        AND session.revoked_at IS NULL
        AND session.expires_at > now()
        AND identity_user.status = 'active'
        AND identity_user.deleted_at IS NULL
        AND (
          session.active_tenant_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM memberships AS membership
            JOIN tenants AS tenant ON tenant.id = membership.tenant_id
            WHERE
              membership.user_id = session.user_id
              AND membership.tenant_id = session.active_tenant_id
              AND membership.status = 'active'
              AND tenant.status = 'active'
              AND tenant.deleted_at IS NULL
          )
        )
      RETURNING
        session.id,
        session.user_id AS "userId",
        session.active_tenant_id AS "activeTenantId",
        session.csrf_hash AS "csrfHash",
        session.expires_at AS "expiresAt",
        identity_user.email::text AS email,
        identity_user.display_name AS "displayName"
    `;
    return rows[0];
  }
}

function isValidSessionToken(value: string | undefined): value is string {
  return Boolean(value && SESSION_TOKEN_PATTERN.test(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toSessionView(session: SessionDatabaseView): SessionView {
  return {
    active_tenant_id: session.activeTenantId,
    expires_at: new Date(session.expiresAt).toISOString(),
    user: {
      display_name: session.displayName,
      email: session.email,
      id: session.userId,
    },
  };
}
