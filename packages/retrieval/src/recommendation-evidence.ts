import type postgres from 'postgres';
import {
  EditorialContextSchema,
  findPublishedOwnerCompanyNames,
  readOfficialSiteServicePhone,
  type EditorialContext,
} from '@geo-content-os/contracts';

export class RecommendationEvidenceError extends Error {
  public readonly code = 'RECOMMENDATION_EVIDENCE_UNAVAILABLE';
}

/** Resolve automatic sources only when creating a candidate; the writer/version keeps the resolved IDs. */
export async function resolveRecommendationContext(
  client: postgres.Sql | postgres.TransactionSql,
  scope: { tenantId: string; workspaceId: string; projectId: string; userId: string },
  context: EditorialContext,
): Promise<EditorialContext> {
  if (
    context.style !== 'company_recommendation' ||
    context.evidence_resolved ||
    !context.companies.some((company) => company.evidence_mode || company.description_source_id)
  )
    return context;
  const [brand] = await client<
    { profile: unknown }[]
  >`SELECT profile_json AS profile FROM brand_profiles
    WHERE tenant_id=${scope.tenantId}::uuid AND workspace_id=${scope.workspaceId}::uuid AND status='published'
    ORDER BY version DESC LIMIT 1`;
  const owners = findPublishedOwnerCompanyNames(brand?.profile);
  if (owners.length !== 1) throw new RecommendationEvidenceError('请先发布主公司的唯一企业身份。');
  const owner = owners[0]!;
  const [workspace] = await client<{ settings: Record<string, unknown> }[]>`
    SELECT settings_json AS settings FROM workspaces
    WHERE tenant_id=${scope.tenantId}::uuid AND id=${scope.workspaceId}::uuid`;
  const primaryPhone = readOfficialSiteServicePhone(workspace?.settings);
  const primary = context.companies.find(
    (company) => company.evidence_mode === 'primary' && company.legal_name === owner,
  );
  if (
    context.companies.some(
      (company) => company.evidence_mode === 'primary' && company.legal_name !== owner,
    )
  )
    throw new RecommendationEvidenceError('主公司与当前发布企业身份不一致。');
  if (context.companies.some((company) => company.evidence_mode === 'inherit_primary') && !primary)
    throw new RecommendationEvidenceError('沿用服务前请保留主公司配置。');
  const otherNames = context.companies
    .filter((company) => company.legal_name !== owner)
    .map((company) => company.legal_name);
  const sources = await client<{ id: string; certificate: boolean }[]>`
    SELECT source.id,COALESCE(source.metadata_json->>'schema_version' IN ('source-certificate@1','source-insurance-proof@1'),false) AS certificate
    FROM source_documents source
    WHERE source.tenant_id=${scope.tenantId}::uuid AND source.workspace_id=${scope.workspaceId}::uuid
      AND (source.project_id IS NULL OR source.project_id=${scope.projectId}::uuid)
      AND has_project_scope_access(source.tenant_id,source.workspace_id,source.project_id,${scope.userId}::uuid)
      AND source.status='active' AND source.deleted_at IS NULL AND source.trust_level IN ('normal','verified')
      AND (source.source_type<>'url' OR position(${owner} IN source.title)>0)
      AND (source.effective_from IS NULL OR source.effective_from<=(now() AT TIME ZONE 'Asia/Shanghai')::date)
      AND (source.effective_to IS NULL OR source.effective_to>=(now() AT TIME ZONE 'Asia/Shanghai')::date)
      AND (source.title NOT LIKE '推荐业务说明 · %' OR source.id=${primary?.description_source_id ?? null}::uuid)
      AND EXISTS (SELECT 1 FROM source_chunks chunk WHERE chunk.tenant_id=source.tenant_id AND chunk.source_document_id=source.id AND chunk.status='active')
      AND NOT EXISTS (SELECT 1 FROM unnest(${otherNames}::text[]) AS other_name WHERE position(other_name IN source.title)>0)
      AND CASE source.metadata_json->>'schema_version'
        WHEN 'source-certificate@1' THEN source.metadata_json @> '{"article_use_allowed":true,"public_display_confirmed":true}'::jsonb AND source.metadata_json->>'holder_name'=${owner}
        WHEN 'source-insurance-proof@1' THEN source.metadata_json->'summary_use_confirmed'='true'::jsonb AND source.metadata_json->>'policyholder_name'=${owner}
        ELSE true END
    ORDER BY (source.title=${`推荐业务说明 · ${owner}`}) DESC, (source.trust_level='verified') DESC,source.updated_at DESC,source.id LIMIT 100`;
  return EditorialContextSchema.parse({
    ...context,
    primary_company_name: owner,
    evidence_resolved: true,
    companies: context.companies.map((company) => {
      const explicit = [
        ...new Set([
          ...company.source_document_ids,
          ...(company.description_source_id ? [company.description_source_id] : []),
        ]),
      ];
      if (explicit.length > 12)
        throw new RecommendationEvidenceError(
          `推荐企业资料超过 12 份：${company.legal_name}。请减少手动绑定资料，业务说明也计入一份。`,
        );
      const auto =
        company.evidence_mode === 'primary'
          ? sources
          : company.evidence_mode === 'inherit_primary'
            ? sources.filter((source) => !source.certificate)
            : [];
      if (company.evidence_mode === 'inherit_primary' && company.legal_name === owner)
        throw new RecommendationEvidenceError('主公司不能沿用自身作为其他企业服务。');
      return {
        ...company,
        ...(company.legal_name === owner ? { service_phone: primaryPhone ?? undefined } : {}),
        source_document_ids: [...new Set([...explicit, ...auto.map((source) => source.id)])].slice(
          0,
          12,
        ),
      };
    }),
  });
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
      CASE source.metadata_json->>'schema_version'
        WHEN 'source-certificate@1' THEN source.metadata_json->>'holder_name'
        WHEN 'source-insurance-proof@1' THEN source.metadata_json->>'policyholder_name'
      END AS "certificateHolder"
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
