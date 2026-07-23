import type { QualityGeoScores } from '@geo-content-os/contracts/skills';

import { calculateGeoTotal, validateGeoScores } from './geo-score.js';
import { QualityPipelineError } from './quality-pipeline.errors.js';
import type { QualityPipelineRepository } from './quality-pipeline.repository.js';
import { applyRequiredQualityPolicy } from './quality-policy.js';
import type {
  QualityEvaluationInput,
  QualityEvaluatorPort,
  QualityPipelineRequest,
  QualityPipelineScope,
  QualityReportView,
} from './quality-pipeline.types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

export class QualityPipelineService {
  public constructor(
    private readonly repository: QualityPipelineRepository,
    private readonly evaluator: QualityEvaluatorPort,
  ) {}

  public async run(
    scope: QualityPipelineScope,
    request: QualityPipelineRequest,
  ): Promise<QualityReportView> {
    validateRequest(scope, request);
    const checkerVersion = request.checkerVersion.trim();
    const existing = await this.repository.findByRun(scope);
    if (existing) {
      if (
        existing.contentVersionId !== request.contentVersionId ||
        existing.checkerVersion !== checkerVersion
      ) {
        throw new QualityPipelineError(
          'QUALITY_IDEMPOTENCY_CONFLICT',
          'Quality run already completed with different immutable input',
        );
      }
      return existing;
    }

    const geoScores = validateGeoScores(request.geoScores);
    const context = await this.repository.loadContext(scope, request);
    if (context.platformCode !== request.platformRules.platform_code) {
      invalid('Platform rules do not match the Variant platform');
    }
    const evaluationInput: QualityEvaluationInput = Object.freeze({
      brand_policy: context.brandProfile,
      content_version: context.content,
      duplicate_matches: Object.freeze([...request.duplicateMatches]),
      fact_results: context.factResults,
      geo_result: Object.freeze({ scores: geoScores }),
      platform_rules: Object.freeze(request.platformRules),
      safety_policy: Object.freeze(request.safetyPolicy),
    });
    const assessment = await this.evaluator.evaluate({
      input: evaluationInput,
      requestId: request.requestId.trim(),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const returnedGeoScores = validateGeoScores(assessment.geo_scores);
    if (!sameGeoScores(geoScores, returnedGeoScores)) {
      throw new QualityPipelineError(
        'QUALITY_EVALUATION_INVALID',
        'Quality evaluator changed the supplied GEO scores',
      );
    }
    const final = applyRequiredQualityPolicy({
      assessment,
      brand: context.brandProfile.policy,
      content: context.content.content,
      factResults: context.factResults,
      maxWarningsForPass: request.safetyPolicy.max_warnings_for_pass,
      platformCode: context.platformCode,
    });
    return this.repository.persist(scope, {
      checkerVersion,
      contentVersionId: request.contentVersionId,
      decision: final.decision,
      expectedGenerationRunVersion: context.generationRunVersion,
      expectedVariantVersion: context.variantVersion,
      geoScores,
      issues: final.issues,
      requestId: request.requestId.trim(),
      score: final.score,
    });
  }
}

function validateRequest(scope: QualityPipelineScope, request: QualityPipelineRequest): void {
  for (const value of Object.values(scope)) {
    if (!UUID_PATTERN.test(value)) invalid('Quality scope contains an invalid UUID');
  }
  for (const value of [
    request.brandProfileId,
    request.contentVersionId,
    request.factCheckGenerationRunId,
    request.platformRules.version_id,
  ]) {
    if (!UUID_PATTERN.test(value)) invalid('Quality request contains an invalid UUID');
  }
  if (!Number.isInteger(request.expectedVariantVersion) || request.expectedVariantVersion < 1) {
    invalid('expectedVariantVersion is invalid');
  }
  const checkerVersion = request.checkerVersion.trim();
  if (checkerVersion.length > 32 || !SEMVER_PATTERN.test(checkerVersion)) {
    invalid('checkerVersion is invalid');
  }
  if (!HASH_PATTERN.test(request.platformRules.rules_hash))
    invalid('Platform rules hash is invalid');
  if (
    typeof request.safetyPolicy.block_on_data_leakage !== 'boolean' ||
    typeof request.safetyPolicy.block_on_injection !== 'boolean' ||
    !Number.isInteger(request.safetyPolicy.max_warnings_for_pass) ||
    request.safetyPolicy.max_warnings_for_pass < 0 ||
    request.safetyPolicy.max_warnings_for_pass > 1_000
  ) {
    invalid('Safety policy is invalid');
  }
  const requestId = request.requestId.trim();
  if (requestId.length === 0 || requestId.length > 80) invalid('requestId is invalid');
  if (request.duplicateMatches.length > 1_000) invalid('duplicateMatches is too large');
  const duplicateIds = new Set<string>();
  for (const match of request.duplicateMatches) {
    if (
      !UUID_PATTERN.test(match.content_version_id) ||
      !Number.isFinite(match.similarity) ||
      match.similarity < 0 ||
      match.similarity > 1 ||
      (match.excerpt !== null && match.excerpt.length > 10_000)
    ) {
      invalid('duplicateMatches contains an invalid item');
    }
    if (duplicateIds.has(match.content_version_id)) invalid('duplicateMatches contains duplicates');
    duplicateIds.add(match.content_version_id);
  }
}

function sameGeoScores(left: QualityGeoScores, right: QualityGeoScores): boolean {
  return (
    left.entity === right.entity &&
    left.question === right.question &&
    left.answerability === right.answerability &&
    left.evidence === right.evidence &&
    left.platform_fit === right.platform_fit &&
    left.readability_safety === right.readability_safety &&
    left.total === right.total &&
    left.total === calculateGeoTotal(left)
  );
}

function invalid(message: string): never {
  throw new QualityPipelineError('QUALITY_INPUT_INVALID', message);
}
