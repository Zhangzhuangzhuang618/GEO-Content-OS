import type postgres from 'postgres';

import type { BaijiahaoAutomation } from './baijiahao-automation.js';
import type { OfficialSiteAutomation } from './official-site-automation.js';
import type { ValidatedGenerationEvent } from './generation.types.js';

export interface GenerationAutomationPort {
  queueQualityAfterGeneration(
    transaction: postgres.TransactionSql,
    event: ValidatedGenerationEvent,
    variantId: string,
    contentVersionId: string,
    generatedHash: string,
  ): Promise<void>;
}

export class GenerationAutomationCoordinator implements GenerationAutomationPort {
  public constructor(
    private readonly officialSite: OfficialSiteAutomation,
    private readonly baijiahao: BaijiahaoAutomation,
  ) {}

  public async queueQualityAfterGeneration(
    transaction: postgres.TransactionSql,
    event: ValidatedGenerationEvent,
    variantId: string,
    contentVersionId: string,
    generatedHash: string,
  ): Promise<void> {
    await this.officialSite.queueQualityAfterGeneration(
      transaction,
      event,
      variantId,
      contentVersionId,
      generatedHash,
    );
    await this.baijiahao.queueQualityAfterGeneration(
      transaction,
      event,
      variantId,
      contentVersionId,
      generatedHash,
    );
  }
}
