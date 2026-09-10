import { isDeepStrictEqual } from 'node:util';
import type { JsonObject } from '@geo-content-os/adapter-model';
import { QUALITY_CHECKER_DATA_SCHEMA, type QualityIssue } from '@geo-content-os/contracts/skills';
import { SchemaGuard } from '@geo-content-os/skills/runtime';

// JSON repair is not a new assessment of the article. Never let it erase or
// downgrade a well-formed finding to make the report schema-valid.
export function qualityOutputGuard(maxWarningsForPass: number): (value: unknown) => unknown {
  const schemas = new SchemaGuard();
  const properties = QUALITY_CHECKER_DATA_SCHEMA['properties'] as JsonObject;
  const issueSchema = (properties['issues'] as JsonObject)['items'] as JsonObject;
  let preserved: readonly QualityIssue[] = [];
  return (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const report = value as Record<string, unknown>;
    const issues = Array.isArray(report['issues']) ? report['issues'] : [];
    if (
      preserved.some((issue) => !issues.some((candidate) => isDeepStrictEqual(issue, candidate)))
    ) {
      // Deliberately not SKILL_OUTPUT_INVALID: the caller must not retry this
      // loss as a fresh semantic assessment and accidentally return pass.
      throw new Error(
        'QUALITY_REPAIR_FINDINGS_LOST: schema repair removed or changed an existing quality finding',
      );
    }
    preserved = issues.filter(
      (issue): issue is QualityIssue => schemas.check(issueSchema, issue).valid,
    );
    if (!Array.isArray(report['issues']) || preserved.length !== issues.length) return value;
    const decision = preserved.some((issue) => issue.severity === 'BLOCK')
      ? 'block'
      : preserved.filter((issue) => issue.severity === 'WARN').length > maxWarningsForPass
        ? 'revise'
        : 'pass';
    // This is the existing frozen gate, not a relaxed schema. Keep all findings,
    // scores, citations and locations verbatim; normal schema/semantic checks follow.
    return { ...report, decision };
  };
}
