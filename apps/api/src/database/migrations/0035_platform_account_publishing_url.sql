ALTER TABLE platform_accounts
  ADD COLUMN publishing_url text,
  ADD CONSTRAINT platform_accounts_publishing_url_check CHECK (
    publishing_url IS NULL OR (
      char_length(publishing_url) BETWEEN 1 AND 2048
      AND publishing_url ~ '^https?://'
    )
  );
