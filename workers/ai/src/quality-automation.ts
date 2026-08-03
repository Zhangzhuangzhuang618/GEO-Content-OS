import type { QualityCheckerData, QualityGeoScores } from '@geo-content-os/contracts/skills';
import type postgres from 'postgres';

import type {
  BaijiahaoAutomation,
  BaijiahaoAutomationPolicy,
  BaijiahaoQualityGate,
} from './baijiahao-automation.js';
import type {
  OfficialSiteAutomation,
  OfficialSiteAutomationPolicy,
  OfficialSiteQualityGate,
} from './official-site-automation.js';
import type { ValidatedQualityEvent } from './quality.event.js';
import type { ContentMediaAutomation } from './content-media-automation.js';

type AutomationSql = postgres.Sql | postgres.TransactionSql;

export type QualityAutomationPolicy =
  | { readonly kind: 'baijiahao'; readonly value: BaijiahaoAutomationPolicy }
  | { readonly kind: 'official_site'; readonly value: OfficialSiteAutomationPolicy };

export type QualityAutomationGate = BaijiahaoQualityGate | OfficialSiteQualityGate;

export interface QualityAutomationPort {
  advanceAfterQuality(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    policy: QualityAutomationPolicy,
    reportId: string,
    gate: QualityAutomationGate,
    result: QualityCheckerData,
  ): Promise<void>;
  calculateGate(
    policy: QualityAutomationPolicy,
    result: QualityCheckerData,
    geoScores: QualityGeoScores,
  ): QualityAutomationGate;
  failQualityExecution(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    error: unknown,
  ): Promise<void>;
  loadGatePolicy(
    transaction: AutomationSql,
    tenantId: string,
    variantId: string,
  ): Promise<QualityAutomationPolicy | null>;
}

export class QualityAutomationCoordinator implements QualityAutomationPort {
  public constructor(
    private readonly officialSite: OfficialSiteAutomation,
    private readonly baijiahao: BaijiahaoAutomation,
    private readonly media?: ContentMediaAutomation,
  ) {}

  public async loadGatePolicy(
    transaction: AutomationSql,
    tenantId: string,
    variantId: string,
  ): Promise<QualityAutomationPolicy | null> {
    const official = await this.officialSite.loadGatePolicy(transaction, tenantId, variantId);
    if (official) return Object.freeze({ kind: 'official_site', value: official });
    const baijiahao = await this.baijiahao.loadGatePolicy(transaction, tenantId, variantId);
    return baijiahao ? Object.freeze({ kind: 'baijiahao', value: baijiahao }) : null;
  }

  public calculateGate(
    policy: QualityAutomationPolicy,
    result: QualityCheckerData,
    geoScores: QualityGeoScores,
  ): QualityAutomationGate {
    return policy.kind === 'official_site'
      ? this.officialSite.calculateGate(policy.value, result, geoScores)
      : this.baijiahao.calculateGate(policy.value, result, geoScores);
  }

  public advanceAfterQuality(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    policy: QualityAutomationPolicy,
    reportId: string,
    gate: QualityAutomationGate,
    result: QualityCheckerData,
  ): Promise<void> {
    if (this.media?.shouldEnqueue(gate)) {
      return this.media.enqueue(transaction, event, policy, reportId);
    }
    if (policy.kind === 'official_site') {
      if (gate.schema_version !== 'official-site-quality-gate@1') {
        throw new Error('Official-site quality gate type is invalid');
      }
      return this.officialSite.advanceAfterQuality(
        transaction,
        event,
        policy.value,
        reportId,
        gate,
        result,
      );
    }
    if (gate.schema_version !== 'baijiahao-quality-gate@1') {
      throw new Error('Baijiahao quality gate type is invalid');
    }
    return this.baijiahao.advanceAfterQuality(
      transaction,
      event,
      policy.value,
      reportId,
      gate,
      result,
    );
  }

  public async failQualityExecution(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    error: unknown,
  ): Promise<void> {
    await this.officialSite.failQualityExecution(transaction, event, error);
    await this.baijiahao.failQualityExecution(transaction, event, error);
  }
}
