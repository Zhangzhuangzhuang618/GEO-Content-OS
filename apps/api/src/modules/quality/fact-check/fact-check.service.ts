import { FactCheckError } from './fact-check.errors.js';
import { normalizeFactClaim, sha256 } from './claim-normalizer.js';
import type { FactCheckRepository } from './fact-check.repository.js';
import type {
  FactCheckRequest,
  FactCheckResultView,
  FactCheckScope,
  FactClaimJudgePort,
  FactEvidenceCandidate,
  FactEvidenceSearchPort,
  FactJudgement,
  NormalizedFactClaim,
  PreparedFactCheckResult,
} from './fact-check.types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERDICTS = new Set([
  'supported',
  'partially_supported',
  'conflicted',
  'unsupported',
  'outdated',
]);
const SUPPORT_LEVELS = new Set(['supported', 'partially_supported', 'conflicted', 'outdated']);

export class FactCheckService {
  public constructor(
    private readonly repository: FactCheckRepository,
    private readonly evidenceSearch: FactEvidenceSearchPort,
    private readonly judge: FactClaimJudgePort,
  ) {}

  public async check(
    scope: FactCheckScope,
    request: FactCheckRequest,
  ): Promise<readonly FactCheckResultView[]> {
    validateScope(scope);
    const requestId = request.requestId.trim();
    if (requestId.length === 0 || requestId.length > 80) invalidInput('requestId is invalid');
    if (request.claims.length === 0 || request.claims.length > 200) {
      invalidInput('claims must contain 1..200 items');
    }

    const claims = request.claims.map(normalizeFactClaim);
    const uniqueHashes = new Set<string>();
    for (const claim of claims) {
      if (uniqueHashes.has(claim.claimHash))
        invalidInput('claims contain duplicate normalized text');
      uniqueHashes.add(claim.claimHash);
    }
    const claimHashes = claims.map((claim) => claim.claimHash);
    const existing = await this.repository.findByClaimHashes(scope, claimHashes);
    const existingByHash = new Map(existing.map((result) => [result.claimHash, result]));
    for (const claim of claims) {
      const result = existingByHash.get(claim.claimHash);
      if (result && (result.claimKey !== claim.claimKey || result.riskLevel !== claim.riskLevel)) {
        throw new FactCheckError(
          'FACT_CHECK_IDEMPOTENCY_CONFLICT',
          'The normalized claim already exists with different immutable metadata',
        );
      }
    }
    if (existing.length === claims.length) return existing;

    const prepared: PreparedFactCheckResult[] = [];
    for (const claim of claims) {
      if (existingByHash.has(claim.claimHash)) continue;
      const candidates = await this.evidenceSearch.search({
        claim,
        requestId,
        scope,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      validateCandidates(candidates);
      const judgement =
        candidates.length === 0
          ? noEvidenceJudgement()
          : await this.judge.judge({
              candidates,
              claim,
              requestId,
              scope,
              ...(request.signal ? { signal: request.signal } : {}),
            });
      prepared.push(prepareResult(claim, candidates, judgement));
    }
    return this.repository.persist(scope, prepared, claimHashes);
  }
}

function prepareResult(
  claim: NormalizedFactClaim,
  candidates: readonly FactEvidenceCandidate[],
  judgement: FactJudgement,
): PreparedFactCheckResult {
  if (!VERDICTS.has(judgement.verdict)) invalidJudgement('verdict is invalid');
  validateConfidence(judgement.confidence, 'judgement confidence');
  const reason = judgement.reason.trim();
  if (reason.length === 0 || reason.length > 4_000) invalidJudgement('reason is invalid');
  const rewriteSuggestion = judgement.rewriteSuggestion?.trim() || null;
  if (rewriteSuggestion && rewriteSuggestion.length > 10_000) {
    invalidJudgement('rewriteSuggestion is too long');
  }
  if (judgement.verdict === 'unsupported' && judgement.evidences.length !== 0) {
    invalidJudgement('unsupported verdict must not include evidence');
  }
  if (judgement.verdict !== 'unsupported' && judgement.evidences.length === 0) {
    invalidJudgement('non-unsupported verdict requires evidence');
  }

  const candidatesByChunk = new Map(candidates.map((candidate) => [candidate.chunkId, candidate]));
  const evidenceKeys = new Set<string>();
  const evidences = judgement.evidences.map((evidence) => {
    const candidate = candidatesByChunk.get(evidence.chunkId);
    if (!candidate) invalidJudgement('evidence references an unretrieved chunk');
    const quoteText = evidence.quoteText.trim();
    if (
      quoteText.length === 0 ||
      quoteText.length > 10_000 ||
      !candidate.text.includes(quoteText)
    ) {
      invalidJudgement('evidence quote is not a continuous retrieved chunk substring');
    }
    if (!SUPPORT_LEVELS.has(evidence.supportLevel)) invalidJudgement('supportLevel is invalid');
    validateConfidence(evidence.confidence, 'evidence confidence');
    const quoteHash = sha256(quoteText);
    const evidenceKey = `${candidate.chunkId}:${quoteHash}`;
    if (evidenceKeys.has(evidenceKey)) invalidJudgement('evidence is duplicated');
    evidenceKeys.add(evidenceKey);
    return Object.freeze({
      chunkId: candidate.chunkId,
      confidence: evidence.confidence,
      factId: candidate.factId,
      quoteHash,
      quoteText,
      supportLevel: evidence.supportLevel,
    });
  });
  const factIds = new Set(
    evidences.flatMap((evidence) => (evidence.factId ? [evidence.factId] : [])),
  );

  return Object.freeze({
    claim,
    confidence: judgement.confidence,
    evidences: Object.freeze(evidences),
    factId: factIds.size === 1 ? [...factIds][0]! : null,
    reason,
    rewriteSuggestion,
    verdict: judgement.verdict,
  });
}

function validateCandidates(candidates: readonly FactEvidenceCandidate[]): void {
  const chunkIds = new Set<string>();
  for (const candidate of candidates) {
    if (!UUID_PATTERN.test(candidate.chunkId) || !UUID_PATTERN.test(candidate.sourceDocumentId)) {
      invalidJudgement('retrieval returned an invalid identifier');
    }
    if (candidate.factId !== null && !UUID_PATTERN.test(candidate.factId)) {
      invalidJudgement('retrieval returned an invalid fact identifier');
    }
    if (candidate.text.trim().length === 0 || !/^[0-9a-f]{64}$/.test(candidate.textHash)) {
      invalidJudgement('retrieval returned invalid source text');
    }
    if (!Number.isFinite(candidate.relevanceScore) || candidate.relevanceScore < 0) {
      invalidJudgement('retrieval returned an invalid relevance score');
    }
    if (candidate.trustLevel !== 'verified' && candidate.trustLevel !== 'normal') {
      invalidJudgement('retrieval returned ineligible trust level');
    }
    if (chunkIds.has(candidate.chunkId)) invalidJudgement('retrieval returned duplicate chunks');
    chunkIds.add(candidate.chunkId);
  }
}

function noEvidenceJudgement(): FactJudgement {
  return Object.freeze({
    confidence: 1,
    evidences: Object.freeze([]),
    reason: 'No eligible evidence was retrieved',
    rewriteSuggestion: null,
    verdict: 'unsupported',
  });
}

function validateScope(scope: FactCheckScope): void {
  for (const [name, value] of Object.entries(scope)) {
    if (name !== 'userId' && !UUID_PATTERN.test(value)) invalidInput(`${name} is invalid`);
  }
  if (!UUID_PATTERN.test(scope.userId)) invalidInput('userId is invalid');
}

function validateConfidence(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) invalidJudgement(`${label} is invalid`);
}

function invalidInput(message: string): never {
  throw new FactCheckError('FACT_CHECK_INPUT_INVALID', message);
}

function invalidJudgement(message: string): never {
  throw new FactCheckError('FACT_CHECK_JUDGEMENT_INVALID', message);
}
