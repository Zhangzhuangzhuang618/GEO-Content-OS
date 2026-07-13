import { generateSecureToken } from '@geo-content-os/security';
import { Injectable } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';

export const ARGON2ID_OPTIONS = Object.freeze({
  memoryCost: 19_456,
  parallelism: 1,
  timeCost: 2,
  type: argon2id,
});

@Injectable()
export class PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  public async hash(password: string): Promise<string> {
    return hash(password, ARGON2ID_OPTIONS);
  }

  public async verify(passwordHash: string | null | undefined, password: string): Promise<boolean> {
    const dummyHash = await this.getDummyHash();
    const argon2idHash = passwordHash?.startsWith('$argon2id$') === true;
    const candidate = argon2idHash ? passwordHash : dummyHash;

    try {
      const valid = await verify(candidate, password);
      return argon2idHash && valid;
    } catch {
      await verify(dummyHash, password);
      return false;
    }
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hash(generateSecureToken(), ARGON2ID_OPTIONS);
    return this.dummyHash;
  }
}
