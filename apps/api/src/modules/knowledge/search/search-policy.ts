export interface SearchPolicy {
  readonly citationTopK: number;
  readonly fusedCandidateLimit: number;
  readonly maxChunksPerSource: number;
  readonly modalityCandidateLimit: number;
}

export const DEFAULT_SEARCH_POLICY: Readonly<SearchPolicy> = Object.freeze({
  citationTopK: 5,
  fusedCandidateLimit: 8,
  maxChunksPerSource: 2,
  modalityCandidateLimit: 20,
});

export function validateSearchPolicy(policy: SearchPolicy): Readonly<SearchPolicy> {
  if (
    !Number.isSafeInteger(policy.modalityCandidateLimit) ||
    policy.modalityCandidateLimit < 1 ||
    policy.modalityCandidateLimit > 100 ||
    !Number.isSafeInteger(policy.fusedCandidateLimit) ||
    policy.fusedCandidateLimit < 1 ||
    policy.fusedCandidateLimit > policy.modalityCandidateLimit ||
    !Number.isSafeInteger(policy.citationTopK) ||
    policy.citationTopK < 1 ||
    policy.citationTopK > policy.fusedCandidateLimit ||
    !Number.isSafeInteger(policy.maxChunksPerSource) ||
    policy.maxChunksPerSource < 1 ||
    policy.maxChunksPerSource > policy.citationTopK
  ) {
    throw new TypeError('SearchPolicy is outside supported limits');
  }
  return Object.freeze({ ...policy });
}
