ALTER TABLE source_chunks
  ADD CONSTRAINT source_chunks_token_count_max_check
  CHECK (token_count <= 900);
--> statement-breakpoint
ALTER TABLE source_chunks
  ADD CONSTRAINT source_chunks_locator_required_check
  CHECK (
    metadata_json ?& ARRAY['char_start', 'char_end']::text[]
    AND (metadata_json->>'char_end')::numeric > (metadata_json->>'char_start')::numeric
  );
