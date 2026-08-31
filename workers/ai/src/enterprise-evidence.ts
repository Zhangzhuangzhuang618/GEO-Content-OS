import {
  classifyEnterpriseEvidence,
  missingEnterpriseEvidenceKinds,
  sanitizeEvidenceQuoteForCustomerCopy,
  type EnterpriseEvidenceKind,
  type EnterpriseEvidenceReference,
} from '@geo-content-os/contracts';
import type postgres from 'postgres';

import type { DailyCitation } from './daily-citation-retriever.js';

interface EnterpriseEvidenceRow {
  readonly chunkId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly quoteText: string;
  readonly sourceId: string;
}

export interface EnterpriseEvidenceBundle {
  readonly citations: readonly DailyCitation[];
  readonly missingRequiredKinds: readonly EnterpriseEvidenceKind[];
  readonly references: readonly EnterpriseEvidenceReference[];
}

export async function loadEnterpriseEvidenceBundle(
  client: postgres.Sql | postgres.TransactionSql,
  input: {
    readonly businessDate: string;
    readonly companyName: string;
    readonly projectId: string;
    readonly requiredKinds?: readonly EnterpriseEvidenceKind[];
    readonly tenantId: string;
    readonly workspaceId: string;
  },
): Promise<EnterpriseEvidenceBundle> {
  const rows = await client<EnterpriseEvidenceRow[]>`
    SELECT DISTINCT ON (source.id)
      source.id AS "sourceId",chunk.id AS "chunkId",chunk.text AS "quoteText",
      source.metadata_json AS metadata
    FROM source_documents AS source
    JOIN source_chunks AS chunk
      ON chunk.source_document_id=source.id AND chunk.tenant_id=source.tenant_id
      AND chunk.status='active'
    WHERE source.tenant_id=${input.tenantId}::uuid
      AND source.workspace_id=${input.workspaceId}::uuid
      AND (source.project_id=${input.projectId}::uuid OR source.project_id IS NULL)
      AND source.status='active' AND source.deleted_at IS NULL
      AND source.trust_level IN ('verified','normal')
      AND (source.effective_from IS NULL OR source.effective_from<=${input.businessDate}::date)
      AND (source.effective_to IS NULL OR source.effective_to>=${input.businessDate}::date)
      AND (
        (
          source.metadata_json->>'schema_version'='source-certificate@1'
          AND source.metadata_json->>'holder_name'=${input.companyName}
          AND source.metadata_json @> '{"article_use_allowed":true,"public_display_confirmed":true}'::jsonb
        ) OR (
          source.metadata_json->>'schema_version'='source-insurance-proof@1'
          AND source.metadata_json->>'policyholder_name'=${input.companyName}
          AND source.metadata_json->'summary_use_confirmed'='true'::jsonb
        )
      )
    ORDER BY source.id,chunk.chunk_no,chunk.id
  `;
  const selected = rows.flatMap((row) => {
    const evidence = classifyEnterpriseEvidence(row.metadata);
    if (!evidence) return [];
    const quoteText = sanitizeEvidenceQuoteForCustomerCopy(row.quoteText);
    if (!quoteText) return [];
    return [
      Object.freeze({
        citation: Object.freeze({ chunkId: row.chunkId, quoteText, sourceId: row.sourceId }),
        reference: Object.freeze({
          citationId: row.chunkId,
          displayName: evidence.displayName,
          kind: evidence.kind,
          sourceId: row.sourceId,
        }),
      }),
    ];
  });
  const missingRequiredKinds = missingEnterpriseEvidenceKinds(
    input.requiredKinds ?? [],
    selected.map((item) => item.reference),
  );
  console.warn('Enterprise evidence selection completed', {
    evidence_count: selected.length,
    evidence_source_ids: selected.map((item) => item.reference.sourceId),
    validation_result:
      selected.length === 0 ? 'missing' : missingRequiredKinds.length > 0 ? 'incomplete' : 'passed',
  });
  return Object.freeze({
    citations: Object.freeze(selected.map((item) => item.citation)),
    missingRequiredKinds,
    references: Object.freeze(selected.map((item) => item.reference)),
  });
}
