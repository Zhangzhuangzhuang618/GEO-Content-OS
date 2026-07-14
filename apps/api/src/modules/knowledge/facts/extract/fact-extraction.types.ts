export interface CandidateFactInput {
  readonly confidence: number;
  readonly object_value: string;
  readonly predicate: string;
  readonly source_chunk_no: number;
  readonly subject: string;
}

export interface ExtractCandidateFactsInput {
  readonly candidate_facts: readonly CandidateFactInput[];
  readonly sourceDocumentId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
}

export interface ExtractedFactResult {
  readonly confidence: number;
  readonly created: boolean;
  readonly factId: string;
  readonly factSourceId: string;
  readonly objectValue: string;
  readonly predicate: string;
  readonly quoteHash: string;
  readonly sourceAdded: boolean;
  readonly sourceChunkId: string;
  readonly sourceChunkNo: number;
  readonly status: 'candidate' | 'conflicted' | 'verified';
  readonly subject: string;
}

export interface FactExtractionResult {
  readonly acceptedCandidates: number;
  readonly createdFacts: number;
  readonly createdSources: number;
  readonly facts: readonly ExtractedFactResult[];
  readonly inputCandidates: number;
  readonly sourceDocumentId: string;
}
