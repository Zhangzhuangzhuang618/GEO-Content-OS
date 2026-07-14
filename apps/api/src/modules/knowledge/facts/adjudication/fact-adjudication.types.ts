export type FactAdjudicationDecision = 'conflicted' | 'retired' | 'verified';

export interface VerifyFactRequest {
  readonly decision: FactAdjudicationDecision;
  readonly expected_updated_at: string;
  readonly reason: string;
}

export interface FactAdjudicationAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

export interface AdjudicatedFactView {
  readonly confidence: number;
  readonly created_at: string;
  readonly id: string;
  readonly object_value: string;
  readonly predicate: string;
  readonly status: 'candidate' | FactAdjudicationDecision;
  readonly subject: string;
  readonly tenant_id: string;
  readonly unit: string | null;
  readonly updated_at: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly workspace_id: string;
}
