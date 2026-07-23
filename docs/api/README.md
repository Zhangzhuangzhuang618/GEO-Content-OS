# GEO Content OS API

`apps/api/openapi/openapi.json` 是公开业务 API 的 OpenAPI 3.1 产物，包含 ADR 修订后的 125 个业务端点。`/health/live` 与 `/health/ready` 是部署探针，不属于业务 SDK。

生成：`pnpm generate:openapi`

漂移校验：`pnpm verify:openapi`

SDK 默认使用 `/api/v1` 基址、浏览器 Cookie Session，并支持 JSON 与 `FormData`。写操作按 OpenAPI 中的 `x-idempotency` 传递 `Idempotency-Key` 和/或 `If-Match`。

示例见 `quickstart.ts`。
