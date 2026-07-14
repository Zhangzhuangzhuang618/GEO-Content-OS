import type { MetricDefinition } from '../repositories/index.js';

export interface AnalyticsQueryScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface AnalyticsFilter {
  readonly from: string;
  readonly platformCodes?: readonly string[];
  readonly projectId?: string;
  readonly to: string;
}

export interface MetricAggregate {
  readonly aggregation: MetricDefinition['aggregation'];
  readonly name: string;
  readonly unit: string;
  readonly value: number | null;
}

export interface VisibilityAggregate {
  readonly averageRank: number | null;
  readonly citationCount: number;
  readonly citationRate: number;
  readonly observationCount: number;
}

export interface AnalyticsOverview {
  readonly dataUpdatedAt: string | null;
  readonly methodologyVersion: string;
  readonly metrics: readonly MetricAggregate[];
  readonly visibility: VisibilityAggregate;
}

export interface PlatformAnalytics {
  readonly dataUpdatedAt: string | null;
  readonly metrics: readonly MetricAggregate[];
  readonly platformCode: string;
  readonly visibility: VisibilityAggregate;
}

export interface PlatformAnalyticsResult {
  readonly dataUpdatedAt: string | null;
  readonly methodologyVersion: string;
  readonly platforms: readonly PlatformAnalytics[];
}

export interface ContentAnalyticsQuery extends AnalyticsFilter {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ContentAnalyticsItem {
  readonly dataUpdatedAt: string | null;
  readonly metrics: readonly MetricAggregate[];
  readonly packageId: string;
  readonly platformCode: string;
  readonly projectId: string;
  readonly variantId: string;
}

export interface ContentAnalyticsPage {
  readonly dataUpdatedAt: string | null;
  readonly items: readonly ContentAnalyticsItem[];
  readonly methodologyVersion: string;
  readonly nextCursor: string | null;
}
