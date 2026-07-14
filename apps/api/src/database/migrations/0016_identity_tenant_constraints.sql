ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_id_tenant_uq UNIQUE (id, tenant_id),
  ADD CONSTRAINT outbox_events_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE idempotency_records
  ADD CONSTRAINT idempotency_records_id_tenant_uq UNIQUE (id, tenant_id),
  ADD CONSTRAINT idempotency_records_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
