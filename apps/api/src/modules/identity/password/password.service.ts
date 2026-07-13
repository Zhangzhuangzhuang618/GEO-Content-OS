import { generateSecureToken } from '@geo-content-os/security';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { IdentityAuthDatabase } from '../auth/auth.database.js';
import { PasswordHasher } from '../auth/password-hasher.js';
import { readPasswordConfiguration, type PasswordConfiguration } from './password.config.js';
import { PasswordResetDelivery } from './password-reset.delivery.js';

interface PasswordUser {
  readonly id: string;
  readonly passwordHash: string;
}

@Injectable()
export class PasswordService {
  private readonly configuration: PasswordConfiguration;

  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
    @Inject(PasswordResetDelivery) private readonly delivery: PasswordResetDelivery,
  ) {
    this.configuration = readPasswordConfiguration();
  }

  public async requestReset(email: string): Promise<void> {
    const token = generateSecureToken(32);
    const expiresAt = new Date(Date.now() + this.configuration.resetTtlSeconds * 1_000);
    const [resetToken] = await this.database.client.begin(async (transaction) => {
      const [user] = await transaction<{ email: string; id: string }[]>`
        SELECT id, email::text AS email
        FROM users
        WHERE
          email = ${email}
          AND status = 'active'
          AND deleted_at IS NULL
          AND password_hash IS NOT NULL
        FOR UPDATE
      `;
      await transaction`
        UPDATE password_reset_tokens
        SET used_at = now()
        WHERE user_id = ${user?.id ?? null}::uuid AND used_at IS NULL
      `;
      if (!user) return [];
      return transaction<{ email: string; id: string }[]>`
        INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
        VALUES (${user.id}, ${sha256(token)}, ${expiresAt.toISOString()})
        RETURNING id, ${user.email}::text AS email
      `;
    });
    if (!resetToken) return;

    await this.delivery.deliver({
      email: resetToken.email,
      expiresAt: expiresAt.toISOString(),
      resetTokenId: resetToken.id,
      token,
    });
  }

  public async resetPassword(token: string, newPassword: string): Promise<boolean> {
    const passwordHash = await this.passwordHasher.hash(newPassword);
    return this.database.client.begin(async (transaction) => {
      const resetTokens = await transaction<{ userId: string }[]>`
        SELECT reset_token.user_id AS "userId"
        FROM password_reset_tokens AS reset_token
        JOIN users AS identity_user ON identity_user.id = reset_token.user_id
        WHERE
          reset_token.token_hash = ${sha256(token)}
          AND reset_token.used_at IS NULL
          AND reset_token.expires_at > now()
          AND identity_user.status = 'active'
          AND identity_user.deleted_at IS NULL
          AND identity_user.password_hash IS NOT NULL
        FOR UPDATE OF reset_token
      `;
      const resetToken = resetTokens[0];
      if (!resetToken) return false;

      const updatedUsers = await transaction<{ id: string }[]>`
        UPDATE users
        SET password_hash = ${passwordHash}, password_changed_at = now()
        WHERE
          id = ${resetToken.userId}
          AND status = 'active'
          AND deleted_at IS NULL
          AND password_hash IS NOT NULL
        RETURNING id
      `;
      if (updatedUsers.length !== 1) return false;

      await consumePendingResetTokens(transaction, resetToken.userId);
      await revokeActiveSessions(transaction, resetToken.userId);
      return true;
    });
  }

  public async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const users = await this.database.client<PasswordUser[]>`
      SELECT id, password_hash AS "passwordHash"
      FROM users
      WHERE
        id = ${userId}
        AND status = 'active'
        AND deleted_at IS NULL
        AND password_hash IS NOT NULL
      LIMIT 1
    `;
    const user = users[0];
    const currentPasswordValid = await this.passwordHasher.verify(
      user?.passwordHash,
      currentPassword,
    );
    if (!user || !currentPasswordValid) return false;

    const newPasswordHash = await this.passwordHasher.hash(newPassword);
    return this.database.client.begin(async (transaction) => {
      const updatedUsers = await transaction<{ id: string }[]>`
        UPDATE users
        SET password_hash = ${newPasswordHash}, password_changed_at = now()
        WHERE
          id = ${user.id}
          AND password_hash = ${user.passwordHash}
          AND status = 'active'
          AND deleted_at IS NULL
        RETURNING id
      `;
      if (updatedUsers.length !== 1) return false;

      await consumePendingResetTokens(transaction, user.id);
      await revokeActiveSessions(transaction, user.id);
      return true;
    });
  }
}

async function consumePendingResetTokens(
  transaction: postgres.TransactionSql,
  userId: string,
): Promise<void> {
  await transaction`
    UPDATE password_reset_tokens
    SET used_at = now()
    WHERE user_id = ${userId} AND used_at IS NULL
  `;
}

async function revokeActiveSessions(
  transaction: postgres.TransactionSql,
  userId: string,
): Promise<void> {
  await transaction`
    UPDATE sessions
    SET revoked_at = now()
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
