ALTER TABLE review_snapshots
  ADD COLUMN risk_level varchar(16),
  ADD COLUMN due_at timestamptz,
  ADD COLUMN claimed_by uuid,
  ADD COLUMN claimed_at timestamptz,
  ADD CONSTRAINT review_snapshots_risk_level_check
    CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high', 'critical')),
  ADD CONSTRAINT review_snapshots_claimed_by_membership_fk
    FOREIGN KEY (tenant_id, claimed_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT review_snapshots_claim_pair_check CHECK (
    (claimed_by IS NULL AND claimed_at IS NULL)
    OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL)
  ),
  ADD CONSTRAINT review_snapshots_triage_pair_check CHECK (
    (risk_level IS NULL AND due_at IS NULL)
    OR (risk_level IS NOT NULL AND due_at IS NOT NULL)
  );
--> statement-breakpoint
CREATE INDEX review_snapshots_inbox_claim_idx
  ON review_snapshots (
    tenant_id, status, claimed_by, risk_level, due_at, created_at DESC, id
  );
