import {
  CredentialEnvelopeService,
  type CredentialKeyManagementService,
  LocalCredentialKms,
} from '@geo-content-os/security/credentials';

class UnconfiguredCredentialKms implements CredentialKeyManagementService {
  public currentKeyVersion(): Promise<string> {
    return Promise.reject(new Error('Publishing credential KMS is not configured'));
  }

  public unwrapDataKey(): Promise<Uint8Array> {
    return Promise.reject(new Error('Publishing credential KMS is not configured'));
  }

  public wrapDataKey(): Promise<never> {
    return Promise.reject(new Error('Publishing credential KMS is not configured'));
  }
}

export function createPublishingCredentialService(
  environment: NodeJS.ProcessEnv = process.env,
): CredentialEnvelopeService {
  const encoded = environment['PUBLISHING_CREDENTIAL_KEY_BASE64']?.trim();
  if (!encoded) return new CredentialEnvelopeService(new UnconfiguredCredentialKms());
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('PUBLISHING_CREDENTIAL_KEY_BASE64 must decode to exactly 32 bytes');
  }
  const version = environment['PUBLISHING_CREDENTIAL_KEY_VERSION']?.trim() || 'local-v1';
  return new CredentialEnvelopeService(new LocalCredentialKms(version, { [version]: key }));
}
