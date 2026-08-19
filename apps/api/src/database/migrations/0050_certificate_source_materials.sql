ALTER TABLE source_documents
  ADD COLUMN metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT source_documents_metadata_object_check
    CHECK (jsonb_typeof(metadata_json) = 'object'),
  ADD CONSTRAINT source_documents_metadata_schema_check CHECK (
    metadata_json = '{}'::jsonb OR COALESCE(
      source_type = 'image'
      AND metadata_json->>'schema_version' = 'source-certificate@1'
      AND (metadata_json - ARRAY[
        'schema_version', 'certificate_name', 'certificate_number', 'holder_name',
        'issuing_authority', 'verification_url', 'article_use_allowed',
        'public_display_confirmed'
      ]::text[]) = '{}'::jsonb
      AND char_length(btrim(metadata_json->>'certificate_name')) BETWEEN 1 AND 240
      AND char_length(btrim(metadata_json->>'certificate_number')) BETWEEN 1 AND 120
      AND char_length(btrim(metadata_json->>'holder_name')) BETWEEN 1 AND 240
      AND char_length(btrim(metadata_json->>'issuing_authority')) BETWEEN 1 AND 240
      AND jsonb_typeof(metadata_json->'article_use_allowed') = 'boolean'
      AND jsonb_typeof(metadata_json->'public_display_confirmed') = 'boolean'
      AND (
        metadata_json->'verification_url' = 'null'::jsonb
        OR (
          jsonb_typeof(metadata_json->'verification_url') = 'string'
          AND char_length(metadata_json->>'verification_url') BETWEEN 1 AND 2048
          AND metadata_json->>'verification_url' ~ '^https://'
        )
      )
      AND (
        (metadata_json->>'article_use_allowed')::boolean IS NOT TRUE
        OR (metadata_json->>'public_display_confirmed')::boolean IS TRUE
      ),
      false
    )
  );
--> statement-breakpoint
ALTER TABLE content_media_assets
  DROP CONSTRAINT content_media_assets_source_check,
  ADD CONSTRAINT content_media_assets_source_check
    CHECK (source IN ('cloudflare', 'template', 'certificate'));
