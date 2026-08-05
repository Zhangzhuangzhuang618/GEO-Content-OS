export const QUALITY_EVALUATION_POLICY_VERSION = 'quality-evidence-verification@1';

export function qualityEvaluationFingerprintSource(input: {
  readonly contentHash: string;
  readonly modelKey: string;
  readonly promptVersionId: string;
  readonly skillVersion: string;
}): string {
  return [
    QUALITY_EVALUATION_POLICY_VERSION,
    input.contentHash,
    input.modelKey,
    input.promptVersionId,
    input.skillVersion,
  ].join('\n');
}
