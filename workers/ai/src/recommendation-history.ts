import type postgres from 'postgres';
import type { ContentWriterRunContext, JsonObject } from './generation.types.js';

/** Only current versions from this tenant/workspace/account; old drafts are not evidence. */
export async function recentRecommendationArticles(
  sql: postgres.Sql,
  context: ContentWriterRunContext,
  accountId: string,
  platform: string,
): Promise<JsonObject[]> {
  const rows = await sql<{ content: JsonObject }[]>`
    SELECT cv.content_json AS content FROM content_versions cv
    JOIN content_variants v ON v.current_content_version_id=cv.id AND v.tenant_id=cv.tenant_id
    JOIN content_packages p ON p.id=cv.package_id AND p.tenant_id=cv.tenant_id
    WHERE cv.tenant_id=${context.tenantId}::uuid AND p.workspace_id=${context.workspaceId}::uuid
      AND cv.package_id<>${context.packageId}::uuid
      AND cv.editorial_context_json->>'account_id'=${accountId}
      AND cv.editorial_context_json->>'platform_code'=${platform}
      AND cv.editorial_context_json->>'style'='company_recommendation'
    ORDER BY cv.created_at DESC,cv.id DESC LIMIT 5`;
  return rows.map(({ content }) => recommendationHistoryExcerpt(content));
}

export function recommendationHistoryExcerpt(content: JsonObject): JsonObject {
  const blocks = Array.isArray(content['blocks']) ? content['blocks'] : [];
  return {
    title: String(content['title'] ?? '').slice(0, 100),
    company_sections: blocks
      .filter(
        (block) =>
          block &&
          typeof block === 'object' &&
          /^company_\d+$/u.test(String((block as JsonObject)['block_key'])),
      )
      .slice(0, 10)
      .map((block) => String((block as JsonObject)['text'] ?? '').slice(0, 700)),
  };
}
