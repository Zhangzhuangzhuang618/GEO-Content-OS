export { CitationEvidenceRetriever } from './citation-evidence.retriever.js';
export { normalizeFactClaim, sha256 } from './claim-normalizer.js';
export { FactCheckError, type FactCheckErrorCode } from './fact-check.errors.js';
export { FactCheckRepository } from './fact-check.repository.js';
export { FactCheckService } from './fact-check.service.js';
export type {
  FactCheckRequest,
  FactCheckResultView,
  FactCheckScope,
  FactClaimInput,
  FactClaimJudgePort,
  FactEvidenceCandidate,
  FactEvidenceSearchPort,
  FactEvidenceView,
  FactJudgement,
  FactJudgementEvidence,
  NormalizedFactClaim,
} from './fact-check.types.js';
