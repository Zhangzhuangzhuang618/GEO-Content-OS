# GEO Content OS observability

This directory contains the local/staging observability baseline for OpenTelemetry Collector,
Prometheus, Grafana, and Loki. It does not contain production credentials or notification targets.

Start the application and observability stack as one Compose project with:

```sh
docker compose --project-directory infra -f infra/compose.yaml -f infra/observability/compose.yaml up -d
```

The observability file can also run independently with `--project-directory infra` for
configuration work, but it will not receive application telemetry until a runtime connects to it.

Applications send OTLP metrics/logs to ports `4317` or `4318`. Prometheus scrapes the collector on
`8889`; Grafana is exposed on `3002` by default and provisions the `GEO Content OS Overview`
dashboard automatically.

Runtime processes use `GeoMetricsRegistry` from `@geo-content-os/observability`. Mount
`createPrometheusMetricsHandler()` at `GET /metrics` when direct Prometheus scraping is required,
or forward equivalent OTLP instruments to the collector. Prometheus labels deliberately exclude
tenant, user, account, request, job, and run IDs; use structured logs and traces for those joins.

The alert rules implement the frozen thresholds: API errors above 2%, API P95 above 800 ms, queue
lag above 1000 or five minutes, AI cost growth above 15%, AI schema failures above 1%, publish
success below 95%, any unknown publish result, high-risk audit write failure, and terminal outbox
failure.

Run `pnpm verify:observability` after every metric, dashboard, or alert change.
