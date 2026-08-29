import type { DouyinImageNotePayload } from '@geo-content-os/adapter-platforms/douyin/render';

export type BrowserSessionStatus =
  'login_required' | 'qr_ready' | 'authenticated' | 'reauth' | 'attention_required' | 'disabled';

export interface BrowserSession {
  readonly accountId: string;
  readonly authenticatedAt: Date | null;
  readonly id: string;
  readonly lastVerifiedAt: Date | null;
  readonly lastError: Readonly<Record<string, unknown>> | null;
  readonly profileKey: string;
  readonly qrExpiresAt: Date | null;
  readonly status: BrowserSessionStatus;
  readonly storageStateCiphertext: string | null;
  readonly storageStateKeyVersion: string | null;
  readonly tenantId: string;
  readonly version: number;
}

export type LoginVerificationMethod = 'original_device_scan' | 'sms_code';

export interface LoginVerificationDiagnostic {
  readonly availableMethods: readonly LoginVerificationMethod[];
  readonly capturedAt: Date;
  readonly challengeType:
    | 'identity_choice'
    | 'original_device_scan'
    | 'sms_code'
    | 'sms_send'
    | 'unknown'
    | 'visual_captcha';
  readonly hasCodeInput: boolean;
  readonly pageOrigin: string;
  readonly pagePath: string;
  readonly pageSignature: string;
  readonly qrPng: Uint8Array | null;
  readonly screenshotPng: Uint8Array;
}

export type LoginVerificationInput =
  | { readonly method: 'verification_device_qr' }
  | { readonly method: 'verification_sms_send' }
  | { readonly method: 'verification_sms_verify'; readonly sms_code: string };

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
  readonly payload: DouyinImageNotePayload;
  readonly payloadHash: string;
}

export interface RemotePublication {
  readonly externalId: string;
  readonly reviewReason: string | null;
  readonly status: 'failed' | 'processing' | 'published' | 'unknown';
  readonly url: string | null;
}

export interface BrowserImage {
  readonly assetId: string;
  readonly body: Uint8Array;
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface StoredImageAsset {
  readonly assetId: string;
  readonly contentHash: string;
  readonly mimeType: BrowserImage['mimeType'];
  readonly objectUri: string;
  readonly sizeBytes: number;
}

export interface DriverPublishInput {
  readonly accountId: string;
  readonly contentFingerprint: string;
  readonly images: readonly BrowserImage[];
  readonly payload: DouyinImageNotePayload;
  readonly profilePath: string;
  readonly storageStateJson: string | null;
}

export interface LoginStartResult {
  readonly expiresAt: Date;
  readonly qrPng: Uint8Array;
}

export interface DouyinPageDriver {
  capture(accountId: string): Promise<Uint8Array>;
  close(): Promise<void>;
  exportStorageState(accountId: string): Promise<string>;
  inspectLoginVerification(accountId: string): Promise<LoginVerificationDiagnostic | null>;
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
  startLogin(accountId: string, profilePath: string): Promise<LoginStartResult>;
  submitLoginVerification(
    accountId: string,
    input: LoginVerificationInput,
  ): Promise<LoginVerificationDiagnostic | null>;
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
