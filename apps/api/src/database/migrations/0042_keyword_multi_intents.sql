ALTER TABLE keywords
  ADD COLUMN intents varchar(32)[];
--> statement-breakpoint
UPDATE keywords
SET intents = ARRAY[intent]::varchar(32)[];
--> statement-breakpoint
ALTER TABLE keywords
  ALTER COLUMN intents SET NOT NULL,
  ADD CONSTRAINT keywords_intents_check CHECK (
    cardinality(intents) BETWEEN 1 AND 4
    AND array_position(intents, NULL) IS NULL
    AND intents <@ ARRAY[
      'informational',
      'commercial',
      'transactional',
      'navigational'
    ]::varchar(32)[]
    AND cardinality(array_positions(intents, 'informational')) <= 1
    AND cardinality(array_positions(intents, 'commercial')) <= 1
    AND cardinality(array_positions(intents, 'transactional')) <= 1
    AND cardinality(array_positions(intents, 'navigational')) <= 1
  ),
  ADD CONSTRAINT keywords_primary_intent_check CHECK (intent = intents[1]);
