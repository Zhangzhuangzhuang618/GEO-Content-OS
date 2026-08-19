ALTER TABLE source_documents
  DROP CONSTRAINT source_documents_metadata_schema_check,
  ADD CONSTRAINT source_documents_metadata_schema_check CHECK (
    metadata_json = '{}'::jsonb OR COALESCE(
      (
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
        )
      ) OR (
        source_type = 'pdf'
        AND mime_type = 'application/pdf'
        AND trust_level = 'verified'
        AND effective_from IS NOT NULL
        AND effective_to IS NOT NULL
        AND metadata_json->>'schema_version' = 'source-insurance-proof@1'
        AND (metadata_json - ARRAY[
          'schema_version', 'insurer_name', 'policyholder_name', 'insurance_type',
          'insured_count', 'summary_use_confirmed'
        ]::text[]) = '{}'::jsonb
        AND char_length(btrim(metadata_json->>'insurer_name')) BETWEEN 1 AND 240
        AND char_length(btrim(metadata_json->>'policyholder_name')) BETWEEN 1 AND 240
        AND char_length(btrim(metadata_json->>'insurance_type')) BETWEEN 1 AND 240
        AND CASE
          WHEN jsonb_typeof(metadata_json->'insured_count') = 'number'
            AND metadata_json->>'insured_count' ~ '^[1-9][0-9]{0,5}$'
          THEN (metadata_json->>'insured_count')::integer BETWEEN 1 AND 100000
          ELSE false
        END
        AND metadata_json->'summary_use_confirmed' = 'true'::jsonb
      ),
      false
    )
  );
