LOCK TABLE source_documents IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TEMP TABLE source_url_deduplication_map ON COMMIT DROP AS
WITH source_usage AS (
  SELECT
    source.id,
    count(DISTINCT brief_source.id) AS brief_reference_count,
    count(DISTINCT chunk.id) AS chunk_count
  FROM source_documents AS source
  LEFT JOIN brief_sources AS brief_source
    ON brief_source.tenant_id = source.tenant_id
    AND brief_source.source_document_id = source.id
  LEFT JOIN source_chunks AS chunk
    ON chunk.tenant_id = source.tenant_id
    AND chunk.source_document_id = source.id
  WHERE source.deleted_at IS NULL
    AND source.source_type = 'url'
  GROUP BY source.id
), ranked_sources AS (
  SELECT
    source.id AS duplicate_id,
    first_value(source.id) OVER source_priority AS survivor_id,
    row_number() OVER source_priority AS duplicate_rank
  FROM source_documents AS source
  JOIN source_usage AS usage ON usage.id = source.id
  WHERE source.deleted_at IS NULL
    AND source.source_type = 'url'
  WINDOW source_priority AS (
    PARTITION BY source.tenant_id, source.workspace_id, source.uri
    ORDER BY
      CASE source.status
        WHEN 'active' THEN 0
        WHEN 'processing' THEN 1
        WHEN 'expired' THEN 2
        ELSE 3
      END,
      usage.brief_reference_count DESC,
      usage.chunk_count DESC,
      source.updated_at DESC,
      source.created_at DESC,
      source.id DESC
  )
)
SELECT duplicate_id, survivor_id
FROM ranked_sources
WHERE duplicate_rank > 1;
--> statement-breakpoint
INSERT INTO brief_sources (
  tenant_id,
  brief_id,
  source_document_id,
  required,
  created_at
)
SELECT
  brief_source.tenant_id,
  brief_source.brief_id,
  dedupe.survivor_id,
  bool_or(brief_source.required),
  min(brief_source.created_at)
FROM brief_sources AS brief_source
JOIN source_url_deduplication_map AS dedupe
  ON dedupe.duplicate_id = brief_source.source_document_id
GROUP BY brief_source.tenant_id, brief_source.brief_id, dedupe.survivor_id
ON CONFLICT (tenant_id, brief_id, source_document_id)
DO UPDATE SET required = brief_sources.required OR excluded.required;
--> statement-breakpoint
DELETE FROM brief_sources AS brief_source
USING source_url_deduplication_map AS dedupe
WHERE brief_source.source_document_id = dedupe.duplicate_id;
--> statement-breakpoint
DELETE FROM source_documents AS source
USING source_url_deduplication_map AS dedupe
WHERE source.id = dedupe.duplicate_id;
--> statement-breakpoint
CREATE UNIQUE INDEX uq_source_url_active
  ON source_documents (tenant_id, workspace_id, uri)
  WHERE deleted_at IS NULL AND source_type = 'url';
