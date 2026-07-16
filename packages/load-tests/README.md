# T139 load tests

This package measures API, RAG and queue enqueue latency and throughput while sustaining exactly 100
workspace identities for the configured duration. It also records a queue recovery probe when the
target exposes a controlled fault endpoint.

## Acceptance run

`pnpm test:load` runs the suite with the pinned `grafana/k6:2.0.0` image against a deterministic local
fixture. The result proves that the workload, thresholds, report generation and recovery probe work. It
does not claim application or production capacity. The generated report is
`packages/load-tests/reports/load-report.json` and is intentionally ignored by Git.

The frozen gates are:

- API P95 at or below 800 ms.
- RAG request P95 at or below 800 ms because it is an API workload.
- Queue enqueue P95 at or below 2 seconds.
- Failed request rate below 1%.
- Exactly 100 accepted workspace identities.

The deliberate first 503 from the recovery probe is marked as an expected response and is excluded
from the ordinary failed-request rate; the probe has its own recovery counter and latency gate.

## Test-target run

Set `LOAD_BASE_URL` to run against an isolated test environment. Real platform publication and
production targets are outside this suite.

```text
LOAD_BASE_URL=https://staging.example.test \
LOAD_API_PATH=/api/v1/analytics/overview \
LOAD_RAG_PATH=/test-support/rag/search \
LOAD_QUEUE_PATH=/test-support/queue/enqueue \
LOAD_SESSION_COOKIE='session=...' \
LOAD_CSRF_TOKEN='...' \
LOAD_DURATION=30s \
pnpm test:load
```

The target must accept `X-Load-Workspace` and map it server-side to seeded tenant/workspace context;
the header is only a test-harness selector and must not be trusted by production authorization code.
Synthetic queue recovery is disabled in target mode. To enable it, provide a controlled endpoint that
returns 503 on the first idempotent request and 202 on retry, then set
`LOAD_QUEUE_RECOVERY_ENABLED=true` and `LOAD_QUEUE_RECOVERY_PATH`.

Use `K6_RUNTIME=native` when a local k6 binary is installed. Docker mode is the default; a target bound
to localhost must be exposed to Docker as `host.docker.internal`.
