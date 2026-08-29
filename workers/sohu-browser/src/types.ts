import type { SohuPayload } from '@geo-content-os/adapter-platforms/sohu/render';
import type { SohuBrowserLoginRequest } from '@geo-content-os/contracts';

export type BrowserSessionStatus =
  'login_required' | 'qr_ready' | 'authenticated' | 'reauth' | 'attention_required' | 'disabled';

export interface BrowserSession {
  readonly accountId: string;
  readonly authenticatedAt: Date | null;
  readonly id: string;
  readonly lastVerifiedAt: Date | null;
  readonly profileKey: string;
  readonly qrExpiresAt: Date | null;
  readonly status: BrowserSessionStatus;
  readonly storageStateCiphertext: string | null;
  readonly storageStateKeyVersion: string | null;
  readonly tenantId: string;
  readonly version: number;
}

export interface PublicationClaim {
  readonly accountId: string;
  readonly contentVersionId: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly publishJobId: string;
  readonly sessionId: string;
  readonly status:
    | 'prepared'
    | 'submitting'
    | 'unknown'
    | 'processing'
    | 'published'
    | 'failed'
    | 'manual_required';
  readonly tenantId: string;
  readonly version: number;
}

export interface BrowserPublishInput {
  readonly contentVersionId: string;
  readonly idempotencyKey: string;
  readonly payload: SohuPayload;
  readonly payloadHash: string;
}

export interface RemotePublication {
  readonly externalId: string;
  readonly reviewReason: string | null;
  readonly status: 'failed' | 'processing' | 'published' | 'unknown';
  readonly url: string | null;
}

export interface DriverPublishInput {
  readonly accountId: string;
  readonly contentFingerprint: string;
  readonly images: readonly BrowserImage[];
  readonly payload: SohuPayload;
  readonly profilePath: string;
  readonly storageStateJson: string | null;
}

export interface BrowserImage {
  readonly assetId: string;
  readonly body: Uint8Array;
  readonly mimeType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  readonly role: 'body' | 'cover';
}

export interface StoredImageAsset {
  readonly assetId: string;
  readonly contentHash: string;
  readonly mimeType: BrowserImage['mimeType'];
  readonly objectUri: string;
  readonly role: BrowserImage['role'];
  readonly sizeBytes: number;
}

export interface LoginStartResult {
  readonly captchaPng?: Uint8Array;
  readonly expiresAt: Date;
  readonly qrPng: Uint8Array;
  readonly smsCodeRequired?: boolean;
}

export interface SohuPageDriver {
  capture(accountId: string): Promise<Uint8Array>;
  close(): Promise<void>;
  exportStorageState(accountId: string): Promise<string>;
  release(accountId: string): Promise<void>;
  reconcile(
    accountId: string,
    profilePath: string,
    match: {
      readonly contentFingerprint: string;
      readonly submittedAfter: Date;
      readonly title: string;
    },
    storageStateJson: string | null,
  ): Promise<RemotePublication | null>;
  startLogin(
    accountId: string,
    profilePath: string,
    input: SohuBrowserLoginRequest,
  ): Promise<LoginStartResult>;
  submit(
    input: DriverPublishInput,
    beforeSubmit: (png: Uint8Array) => Promise<void>,
  ): Promise<RemotePublication>;
  verifyAuthenticated(
    accountId: string,
    profilePath: string,
    storageStateJson: string | null,
  ): Promise<boolean>;
  waitForAuthentication(accountId: string, expiresAt: Date): Promise<boolean>;
}
