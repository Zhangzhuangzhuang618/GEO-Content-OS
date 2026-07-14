CREATE OR REPLACE FUNCTION is_valid_nonblank_text_array(input_values text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT
    cardinality(input_values) BETWEEN 0 AND 50
    AND array_position(input_values, NULL) IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(input_values) AS item
      WHERE btrim(item) = '' OR char_length(btrim(item)) > 240
    )
    AND cardinality(input_values) = (
      SELECT count(DISTINCT lower(btrim(item)))::integer
      FROM unnest(input_values) AS item
    );
$$;
--> statement-breakpoint
ALTER TABLE keywords
  DROP CONSTRAINT keywords_synonyms_check,
  ADD CONSTRAINT keywords_synonyms_check
    CHECK (is_valid_nonblank_text_array(synonyms));
