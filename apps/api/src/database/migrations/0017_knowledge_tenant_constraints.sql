ALTER TABLE ingest_jobs
  ADD CONSTRAINT ingest_jobs_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE source_chunks
  ADD CONSTRAINT source_chunks_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE embeddings
  ADD CONSTRAINT embeddings_id_tenant_uq UNIQUE (id, tenant_id),
  ADD CONSTRAINT embeddings_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE facts
  ADD CONSTRAINT facts_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE fact_sources
  ADD CONSTRAINT fact_sources_id_tenant_uq UNIQUE (id, tenant_id),
  ADD CONSTRAINT fact_sources_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
