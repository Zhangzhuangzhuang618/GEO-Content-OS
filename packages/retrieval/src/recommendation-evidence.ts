import type postgres from 'postgres';

export class RecommendationEvidenceError extends Error {
  public readonly code = 'RECOMMENDATION_EVIDENCE_UNAVAILABLE';
}

/** Explicit account bindings, not a workspace-wide search or a company-name whitelist. */
export async function loadRecommendationEvidence(
  client: postgres.Sql | postgres.TransactionSql,
  scope: { tenantId: string; workspaceId: string; projectId: string; userId: string },
  companies: readonly { id: string; legal_name: string; source_document_ids: readonly string[] }[],
) {
  const sourceIds = [...new Set(companies.flatMap((company) => [...company.source_document_ids]))];
  if (companies.length === 0) return [];
  const rows = await client<
    {
      chunkId: string;
      sourceId: string;
      quoteText: string;
      certificateHolder: string | null;
    }[]
  >`
    SELECT source.id AS "sourceId",chunk.id AS "chunkId",chunk.text AS "quoteText",
      CASE WHEN source.metadata_json->>'schema_version'='source-certificate@1'
        THEN source.metadata_json->>'holder_name' END AS "certificateHolder"
    FROM source_documents AS source
    JOIN workspaces AS workspace ON workspace.id=source.workspace_id AND workspace.tenant_id=source.tenant_id
      AND workspace.status='active' AND workspace.deleted_at IS NULL
    JOIN projects AS project ON project.id=${scope.projectId}::uuid AND project.tenant_id=source.tenant_id
      AND project.workspace_id=source.workspace_id AND project.status='active' AND project.deleted_at IS NULL
    JOIN LATERAL (
      SELECT id,text FROM source_chunks
      WHERE tenant_id=source.tenant_id AND source_document_id=source.id AND status='active'
      ORDER BY chunk_no,id LIMIT 3
    ) AS chunk ON true
    WHERE source.id=ANY(${sourceIds}::uuid[])
      AND source.tenant_id=${scope.tenantId}::uuid AND source.workspace_id=${scope.workspaceId}::uuid
      AND (source.project_id IS NULL OR source.project_id=${scope.projectId}::uuid)
      AND has_project_scope_access(source.tenant_id,source.workspace_id,source.project_id,${scope.userId}::uuid)
      AND source.status='active' AND source.deleted_at IS NULL AND source.trust_level IN ('normal','verified')
      AND (source.effective_from IS NULL OR source.effective_from<=(now() AT TIME ZONE 'Asia/Shanghai')::date)
      AND (source.effective_to IS NULL OR source.effective_to>=(now() AT TIME ZONE 'Asia/Shanghai')::date)
      AND CASE source.metadata_json->>'schema_version'
        WHEN 'source-certificate@1' THEN source.metadata_json @> '{"article_use_allowed":true,"public_display_confirmed":true}'::jsonb
        WHEN 'source-insurance-proof@1' THEN source.metadata_json->'summary_use_confirmed'='true'::jsonb
        ELSE true END
    ORDER BY source.id,chunk.id
    FOR SHARE OF source
  `;
  for (const company of companies) {
    if (
      rows.some(
        (row) =>
          company.source_document_ids.includes(row.sourceId) &&
          row.certificateHolder !== null &&
          row.certificateHolder !== company.legal_name,
      )
    ) {
      throw new RecommendationEvidenceError(
        `证照持证主体与推荐企业不一致：${company.legal_name}。请调整该公司的资料绑定。`,
      );
    }
  }
  const available = new Set(rows.filter((row) => row.quoteText.trim()).map((row) => row.sourceId));
  const missing = companies.filter(
    (company) =>
      company.source_document_ids.length === 0 ||
      company.source_document_ids.some((id) => !available.has(id)),
  );
  if (missing.length) {
    throw new RecommendationEvidenceError(
      `推荐企业资料不可用：${missing.map((company) => company.legal_name).join('、')}。请检查资料授权、项目范围、有效期和解析状态。`,
    );
  }
  return rows;
}
