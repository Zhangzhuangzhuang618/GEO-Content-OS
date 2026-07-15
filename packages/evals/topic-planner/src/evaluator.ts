import { TOPIC_PLANNER_OUTPUT_SCHEMA } from '@geo-content-os/contracts/skills';
import {
  TOPIC_PLANNER_CONTRACT_V1,
  type TopicPlannerFewShot,
} from '@geo-content-os/skills/topic-planner';
import { SchemaGuard } from '@geo-content-os/skills/runtime';

import type {
  TopicPlannerEvalGate,
  TopicPlannerEvalManifest,
  TopicPlannerEvalMetrics,
  TopicPlannerEvalReport,
  TopicPlannerEvalThresholds,
} from './types.js';

interface EvalInput {
  readonly keywords: readonly {
    readonly id: string;
    readonly platform_scope: readonly string[];
  }[];
  readonly platform_scope: readonly string[];
}

export function evaluateTopicPlanner(
  manifest: TopicPlannerEvalManifest,
  cases: readonly TopicPlannerFewShot[] = TOPIC_PLANNER_CONTRACT_V1.fewShots,
  evaluatedAt?: string,
): TopicPlannerEvalReport {
  assertCases(manifest, cases);
  const guard = new SchemaGuard();
  const counts = { brief: 0, evidence: 0, expected: 0, noEvidence: 0, schema: 0, scope: 0 };
  for (const item of cases) {
    if (guard.check(TOPIC_PLANNER_OUTPUT_SCHEMA, item.output).valid) counts.schema += 1;
    if (evidenceIntegrity(item)) counts.evidence += 1;
    if (noEvidenceSafety(item)) counts.noEvidence += 1;
    if (scopeCompliance(item)) counts.scope += 1;
    if (briefLinkage(item)) counts.brief += 1;
    if (expectedBehavior(item)) counts.expected += 1;
  }
  const metrics: TopicPlannerEvalMetrics = Object.freeze({
    briefLinkage: ratio(counts.brief, cases.length),
    caseCount: cases.length,
    evidenceIntegrity: ratio(counts.evidence, cases.length),
    expectedBehavior: ratio(counts.expected, cases.length),
    noEvidenceSafety: ratio(counts.noEvidence, cases.length),
    schemaValidity: ratio(counts.schema, cases.length),
    scopeCompliance: ratio(counts.scope, cases.length),
  });
  const gates = Object.freeze(buildGates(metrics, manifest.thresholds));
  return Object.freeze({
    datasetVersion: manifest.datasetVersion,
    evaluatedAt: timestamp(evaluatedAt),
    gates,
    metrics,
    passed: gates.every((gate) => gate.passed),
    schemaVersion: 'topic-planner-eval-report@1',
    skillVersion: '1.0.0',
  });
}

function assertCases(
  manifest: TopicPlannerEvalManifest,
  cases: readonly TopicPlannerFewShot[],
): void {
  if (
    cases.length !== manifest.caseIds.length ||
    cases.some((item, index) => item.id !== manifest.caseIds[index])
  ) {
    throw new TypeError('Evaluation cases do not match the versioned manifest');
  }
}

function evidenceIntegrity(item: TopicPlannerFewShot): boolean {
  const evidence = new Map(
    item.toolResults.flatMap((result) => {
      const chunkId = result['chunk_id'];
      const quoteText = result['quote_text'];
      return typeof chunkId === 'string' && typeof quoteText === 'string'
        ? ([[chunkId, quoteText]] as const)
        : [];
    }),
  );
  return item.output.data.topics.every((topic) =>
    topic.evidence_ids.every((evidenceId) => {
      const quote = evidence.get(evidenceId);
      return (
        quote !== undefined &&
        item.output.citations.some(
          (citation) => citation.chunk_id === evidenceId && quote.includes(citation.quote_text),
        )
      );
    }),
  );
}

function noEvidenceSafety(item: TopicPlannerFewShot): boolean {
  const evidenceFree = item.output.data.topics.filter((topic) => topic.evidence_ids.length === 0);
  return (
    evidenceFree.every((topic) => topic.risk_level === 'high' || topic.risk_level === 'critical') &&
    (evidenceFree.length === 0 ||
      item.output.warnings.some((warning) => warning.code === 'NO_EVIDENCE'))
  );
}

function scopeCompliance(item: TopicPlannerFewShot): boolean {
  const input = item.input as unknown as EvalInput;
  const keywords = new Map(input.keywords.map((keyword) => [keyword.id, keyword]));
  return item.output.data.topics.every((topic) => {
    const selected = topic.brief_suggestion.keyword_ids.map((id) => keywords.get(id));
    return topic.platform_codes.every(
      (platform) =>
        input.platform_scope.includes(platform) &&
        selected.some((keyword) => keyword?.platform_scope.includes(platform)),
    );
  });
}

function briefLinkage(item: TopicPlannerFewShot): boolean {
  const input = item.input as unknown as EvalInput;
  const keywordIds = new Set(input.keywords.map((keyword) => keyword.id));
  return item.output.data.topics.every(
    (topic) =>
      topic.brief_suggestion.keyword_ids.includes(topic.brief_suggestion.primary_keyword_id) &&
      topic.brief_suggestion.keyword_ids.every((id) => keywordIds.has(id)),
  );
}

function expectedBehavior(item: TopicPlannerFewShot): boolean {
  const topic = item.output.data.topics[0];
  if (!topic) return false;
  if (item.id === 'evidenced-topic-positive') {
    return item.output.status === 'success' && topic.evidence_ids.length > 0;
  }
  if (item.id === 'evidence-free-topic-boundary') {
    return (
      item.output.status === 'success' &&
      topic.evidence_ids.length === 0 &&
      item.output.warnings.some((warning) => warning.code === 'NO_EVIDENCE')
    );
  }
  if (item.id === 'platform-policy-conflict-negative') {
    return (
      item.output.status === 'partial' &&
      item.output.blockers.some((blocker) => blocker.code === 'POLICY_CONFLICT')
    );
  }
  return false;
}

function buildGates(
  metrics: TopicPlannerEvalMetrics,
  thresholds: TopicPlannerEvalThresholds,
): TopicPlannerEvalGate[] {
  return [
    gate('briefLinkageMinimum', metrics.briefLinkage, thresholds),
    gate('evidenceIntegrityMinimum', metrics.evidenceIntegrity, thresholds),
    gate('expectedBehaviorMinimum', metrics.expectedBehavior, thresholds),
    gate('noEvidenceSafetyMinimum', metrics.noEvidenceSafety, thresholds),
    gate('scopeComplianceMinimum', metrics.scopeCompliance, thresholds),
    gate('schemaValidityMinimum', metrics.schemaValidity, thresholds),
  ];
}

function gate(
  name: keyof TopicPlannerEvalThresholds,
  actual: number,
  thresholds: TopicPlannerEvalThresholds,
): TopicPlannerEvalGate {
  return Object.freeze({
    actual,
    gate: name,
    passed: actual >= thresholds[name],
    threshold: thresholds[name],
  });
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(12));
}

function timestamp(value?: string): string {
  if (value === undefined) return new Date().toISOString();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new TypeError('Evaluation timestamp must be a canonical ISO timestamp');
  }
  return value;
}
