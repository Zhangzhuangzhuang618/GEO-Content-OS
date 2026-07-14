import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';

import type { DatabaseClient } from '../../../../database/index.js';
import {
  FactExtractionProvenanceError,
  FactExtractionScopeError,
  FactExtractionValidationError,
} from './fact-extraction.errors.js';
import type {
  CandidateFactInput,
  ExtractCandidateFactsInput,
  ExtractedFactResult,
  FactExtractionResult,
} from './fact-extraction.types.js';

const MAX_CANDIDATES = 500;
const MAX_OBJECT_LENGTH = 16_000;

const CandidateFactSchema = z
  .object({
    confidence: z.number().finite().min(0).max(1),
    object_value: z.string().trim().min(1).max(MAX_OBJECT_LENGTH),
    predicate: z.string().trim().min(1).max(120),
    source_chunk_no: z.number().int().min(0),
    subject: z.string().trim().min(1).max(240),
  })
  .strict();

const ExtractionInputSchema = z
  .object({
    candidate_facts: z.array(CandidateFactSchema).max(MAX_CANDIDATES),
    sourceDocumentId: z.string().uuid(),
    tenantId: z.string().uuid(),
    workspaceId: z.string().uuid(),
  })
  .strict();

interface ExtractableSourceRow {
  readonly id: string;
}

interface ChunkRow {
  readonly chunkNo: number;
  readonly id: string;
  readonly text: string;
  readonly textHash: string;
}

interface FactRow {
  readonly confidence: string;
  readonly id: string;
  readonly objectValue: string;
  readonly predicate: string;
  readonly status: ExtractedFactResult['status'];
  readonly subject: string;
}

interface FactSourceRow {
  readonly id: string;
}

interface PreparedCandidate extends CandidateFactInput {
  readonly identity: string;
  readonly quoteHash: string;
}

export class FactExtractionService {
  public constructor(private readonly client: DatabaseClient) {}

  public async extract(rawInput: unknown): Promise<FactExtractionResult> {
    const input = parseInput(rawInput);
    const candidates = prepareCandidates(input.candidate_facts);

    return this.client.begin(async (transaction) => {
      await assertExtractableSource(transaction, input);
      const chunks = await loadAndValidateChunks(transaction, input, candidates);
      const facts: ExtractedFactResult[] = [];

      // A stable lock order prevents deadlocks when two workers receive the same facts in
      // different model-output orders.
      for (const candidate of [...candidates].sort((left, right) =>
        left.identity.localeCompare(right.identity),
      )) {
        const chunk = chunks.get(candidate.source_chunk_no);
        if (!chunk) {
          throw new FactExtractionProvenanceError(
            `Source chunk ${candidate.source_chunk_no} is missing or inactive`,
          );
        }
        assertGrounded(candidate, chunk);
        facts.push(await persistCandidate(transaction, input, candidate, chunk));
      }

      facts.sort(compareResults);
      return Object.freeze({
        acceptedCandidates: candidates.length,
        createdFacts: facts.filter((fact) => fact.created).length,
        createdSources: facts.filter((fact) => fact.sourceAdded).length,
        facts: Object.freeze(facts),
        inputCandidates: input.candidate_facts.length,
        sourceDocumentId: input.sourceDocumentId,
      });
    });
  }
}

function parseInput(rawInput: unknown): ExtractCandidateFactsInput {
  const parsed = ExtractionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new FactExtractionValidationError(z.prettifyError(parsed.error));
  }
  for (const candidate of parsed.data.candidate_facts) {
    if (
      containsForbiddenControl(candidate.subject) ||
      containsForbiddenControl(candidate.predicate)
    ) {
      throw new FactExtractionValidationError('Fact subject and predicate cannot contain controls');
    }
    if (containsForbiddenControl(candidate.object_value, true)) {
      throw new FactExtractionValidationError('Fact object_value contains a forbidden control');
    }
  }
  return parsed.data;
}

function prepareCandidates(
  candidates: readonly CandidateFactInput[],
): readonly PreparedCandidate[] {
  const unique = new Map<string, PreparedCandidate>();
  for (const candidate of candidates) {
    const confidence = roundConfidence(candidate.confidence);
    const identity = factIdentity(candidate);
    const dedupeKey = `${identity}\u0000${candidate.source_chunk_no}`;
    const existing = unique.get(dedupeKey);
    if (!existing || confidence > existing.confidence) {
      unique.set(dedupeKey, {
        ...candidate,
        confidence,
        identity,
        quoteHash: sha256(candidate.object_value),
      });
    }
  }
  return Object.freeze([...unique.values()]);
}

async function assertExtractableSource(
  transaction: TransactionSql,
  input: ExtractCandidateFactsInput,
): Promise<void> {
  const rows = await transaction<ExtractableSourceRow[]>`
    SELECT id
    FROM source_documents
    WHERE
      id = ${input.sourceDocumentId}::uuid
      AND tenant_id = ${input.tenantId}::uuid
      AND workspace_id = ${input.workspaceId}::uuid
      AND deleted_at IS NULL
      AND status IN ('processing', 'active')
    FOR SHARE
  `;
  if (rows.length !== 1) throw new FactExtractionScopeError();
}

async function loadAndValidateChunks(
  transaction: TransactionSql,
  input: ExtractCandidateFactsInput,
  candidates: readonly PreparedCandidate[],
): Promise<ReadonlyMap<number, ChunkRow>> {
  const chunkNumbers = [...new Set(candidates.map((candidate) => candidate.source_chunk_no))];
  if (chunkNumbers.length === 0) return new Map();
  const rows = await transaction<ChunkRow[]>`
    SELECT
      id,
      chunk_no AS "chunkNo",
      text,
      text_hash AS "textHash"
    FROM source_chunks
    WHERE
      tenant_id = ${input.tenantId}::uuid
      AND source_document_id = ${input.sourceDocumentId}::uuid
      AND chunk_no = ANY(${chunkNumbers}::integer[])
      AND status = 'active'
    ORDER BY chunk_no
    FOR SHARE
  `;
  const chunks = new Map<number, ChunkRow>();
  for (const row of rows) {
    if (sha256(row.text) !== row.textHash) {
      throw new FactExtractionProvenanceError(`Source chunk ${row.chunkNo} text hash is invalid`);
    }
    chunks.set(row.chunkNo, row);
  }
  if (chunks.size !== chunkNumbers.length) {
    throw new FactExtractionProvenanceError('One or more source chunks are missing or inactive');
  }
  return chunks;
}

function assertGrounded(candidate: PreparedCandidate, chunk: ChunkRow): void {
  if (!chunk.text.includes(candidate.object_value)) {
    throw new FactExtractionProvenanceError(
      `Candidate object_value is not a continuous substring of source chunk ${chunk.chunkNo}`,
    );
  }
}

async function persistCandidate(
  transaction: TransactionSql,
  input: ExtractCandidateFactsInput,
  candidate: PreparedCandidate,
  chunk: ChunkRow,
): Promise<ExtractedFactResult> {
  const lockKey = sha256(
    JSON.stringify([
      input.tenantId,
      input.workspaceId,
      candidate.subject,
      candidate.predicate,
      candidate.object_value,
    ]),
  );
  await transaction`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${lockKey}, 0)
    )
  `;
  let rows = await transaction<FactRow[]>`
    SELECT
      id,
      subject,
      predicate,
      object_value AS "objectValue",
      confidence::text AS confidence,
      status
    FROM facts
    WHERE
      tenant_id = ${input.tenantId}::uuid
      AND workspace_id = ${input.workspaceId}::uuid
      AND subject = ${candidate.subject}
      AND predicate = ${candidate.predicate}
      AND object_value = ${candidate.object_value}
      AND status IN ('candidate', 'verified', 'conflicted')
    ORDER BY
      CASE status WHEN 'verified' THEN 0 WHEN 'conflicted' THEN 1 ELSE 2 END,
      created_at,
      id
    LIMIT 1
    FOR UPDATE
  `;
  const created = rows.length === 0;
  if (created) {
    rows = await transaction<FactRow[]>`
      INSERT INTO facts (
        tenant_id, workspace_id, subject, predicate, object_value, confidence, status
      ) VALUES (
        ${input.tenantId}::uuid,
        ${input.workspaceId}::uuid,
        ${candidate.subject},
        ${candidate.predicate},
        ${candidate.object_value},
        ${candidate.confidence},
        'candidate'
      )
      RETURNING
        id,
        subject,
        predicate,
        object_value AS "objectValue",
        confidence::text AS confidence,
        status
    `;
  } else if (rows[0]?.status === 'candidate' && Number(rows[0].confidence) < candidate.confidence) {
    rows = await transaction<FactRow[]>`
      UPDATE facts
      SET confidence = ${candidate.confidence}
      WHERE id = ${rows[0].id}::uuid AND tenant_id = ${input.tenantId}::uuid
      RETURNING
        id,
        subject,
        predicate,
        object_value AS "objectValue",
        confidence::text AS confidence,
        status
    `;
  }
  const fact = rows[0];
  if (!fact) throw new Error('Fact persistence returned no row');

  const insertedSources = await transaction<FactSourceRow[]>`
    INSERT INTO fact_sources (tenant_id, fact_id, chunk_id, quote_text, quote_hash)
    VALUES (
      ${input.tenantId}::uuid,
      ${fact.id}::uuid,
      ${chunk.id}::uuid,
      ${candidate.object_value},
      ${candidate.quoteHash}
    )
    ON CONFLICT (tenant_id, fact_id, chunk_id, quote_hash) DO NOTHING
    RETURNING id
  `;
  const sourceAdded = insertedSources.length === 1;
  let factSourceId = insertedSources[0]?.id;
  if (!factSourceId) {
    const existingSources = await transaction<FactSourceRow[]>`
      SELECT id
      FROM fact_sources
      WHERE
        tenant_id = ${input.tenantId}::uuid
        AND fact_id = ${fact.id}::uuid
        AND chunk_id = ${chunk.id}::uuid
        AND quote_hash = ${candidate.quoteHash}
      LIMIT 1
    `;
    factSourceId = existingSources[0]?.id;
  }
  if (!factSourceId) throw new Error('Fact source persistence returned no row');

  return Object.freeze({
    confidence: Number(fact.confidence),
    created,
    factId: fact.id,
    factSourceId,
    objectValue: fact.objectValue,
    predicate: fact.predicate,
    quoteHash: candidate.quoteHash,
    sourceAdded,
    sourceChunkId: chunk.id,
    sourceChunkNo: candidate.source_chunk_no,
    status: fact.status,
    subject: fact.subject,
  });
}

function factIdentity(candidate: CandidateFactInput): string {
  return `${candidate.subject}\u0000${candidate.predicate}\u0000${candidate.object_value}`;
}

function roundConfidence(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function containsForbiddenControl(value: string, allowTextWhitespace = false): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code === 0x7f ||
      (code < 0x20 && (!allowTextWhitespace || !['\t', '\n', '\r'].includes(character)))
    ) {
      return true;
    }
  }
  return false;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareResults(left: ExtractedFactResult, right: ExtractedFactResult): number {
  return (
    left.sourceChunkNo - right.sourceChunkNo ||
    left.subject.localeCompare(right.subject) ||
    left.predicate.localeCompare(right.predicate) ||
    left.objectValue.localeCompare(right.objectValue)
  );
}
