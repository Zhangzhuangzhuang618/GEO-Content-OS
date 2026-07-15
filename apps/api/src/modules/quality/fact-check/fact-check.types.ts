import type {
  FactCheckRiskLevel,
  FactCheckVerdict,
  FactEvidenceSupportLevel,
} from '../../../database/schema/index.js';

export interface FactCheckScope {
  readonly projectId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly variantId: string;
  readonly workspaceId: string;
  readonly generationRunId: string;
}

export interface FactClaimInput {
  readonly claimKey: string;
  readonly claimText: string;
  readonly riskLevel: FactCheckRiskLevel;
}

export interface NormalizedFactClaim extends FactClaimInput {
  readonly claimHash: string;
  readonly normalizedClaimText: string;
}

export interface FactEvidenceCandidate {
  readonly chunkId: string;
  readonly factId: string | null;
  readonly relevanceScore: number;
  readonly sourceDocumentId: string;
  readonly text: string;
  readonly textHash: string;
  readonly trustLevel: 'verified' | 'normal';
}

export interface FactEvidenceSearchPort {
  search(input: {
    readonly claim: NormalizedFactClaim;
    readonly requestId: string;
    readonly scope: FactCheckScope;
    readonly signal?: AbortSignal;
  }): Promise<readonly FactEvidenceCandidate[]>;
}

export interface FactJudgementEvidence {
  readonly chunkId: string;
  readonly confidence: number;
  readonly quoteText: string;
  readonly supportLevel: FactEvidenceSupportLevel;
}

export interface FactJudgement {
  readonly confidence: number;
  readonly evidences: readonly FactJudgementEvidence[];
  readonly reason: string;
  readonly rewriteSuggestion: string | null;
  readonly verdict: FactCheckVerdict;
}

export interface FactClaimJudgePort {
  judge(input: {
    readonly candidates: readonly FactEvidenceCandidate[];
    readonly claim: NormalizedFactClaim;
    readonly requestId: string;
    readonly scope: FactCheckScope;
    readonly signal?: AbortSignal;
  }): Promise<FactJudgement>;
}

export interface FactEvidenceView {
  readonly chunkId: string;
  readonly confidence: number;
  readonly createdAt: Date;
  readonly factId: string | null;
  readonly id: string;
  readonly quoteHash: string;
  readonly quoteText: string;
  readonly supportLevel: FactEvidenceSupportLevel;
  readonly tenantId: string;
}

export interface FactCheckResultView {
  readonly claimHash: string;
  readonly claimKey: string;
  readonly claimText: string;
  readonly confidence: number;
  readonly createdAt: Date;
  readonly evidences: readonly FactEvidenceView[];
  readonly factId: string | null;
  readonly generationRunId: string;
  readonly id: string;
  readonly reason: string;
  readonly rewriteSuggestion: string | null;
  readonly riskLevel: FactCheckRiskLevel;
  readonly tenantId: string;
  readonly variantId: string;
  readonly verdict: FactCheckVerdict;
}

export interface PreparedFactEvidence {
  readonly chunkId: string;
  readonly confidence: number;
  readonly factId: string | null;
  readonly quoteHash: string;
  readonly quoteText: string;
  readonly supportLevel: FactEvidenceSupportLevel;
}

export interface PreparedFactCheckResult {
  readonly claim: NormalizedFactClaim;
  readonly confidence: number;
  readonly evidences: readonly PreparedFactEvidence[];
  readonly factId: string | null;
  readonly reason: string;
  readonly rewriteSuggestion: string | null;
  readonly verdict: FactCheckVerdict;
}

export interface FactCheckRequest {
  readonly claims: readonly FactClaimInput[];
  readonly requestId: string;
  readonly signal?: AbortSignal;
}
