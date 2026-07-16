import type { Page, Route } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000140';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000140';
const PROJECT_ID = '30000000-0000-4000-8000-000000000140';
const USER_ID = '50000000-0000-4000-8000-000000000140';
const REQUEST_META = Object.freeze({ next_cursor: null, request_id: 'request-a11y-t140' });

export interface A11yApiAudit {
  readonly writeRequests: () => readonly string[];
}

export async function installA11yApiMocks(page: Page): Promise<A11yApiAudit> {
  const writeRequests: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      writeRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
      await json(route, { error: { code: 'READ_ONLY_A11Y_FIXTURE' } }, 405);
      return;
    }

    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/auth/tenants') {
      await json(route, { data: [tenantChoice()], meta: REQUEST_META });
      return;
    }
    if (path === '/api/v1/auth/session') {
      await json(route, {
        data: {
          active_tenant_id: TENANT_ID,
          expires_at: '2026-07-16T18:00:00.000Z',
          user: { display_name: 'A11y Admin', email: 'a11y@example.test', id: USER_ID },
        },
        meta: REQUEST_META,
      });
      return;
    }
    if (path === '/api/v1/workspaces') {
      await json(route, { data: [workspace()], meta: REQUEST_META });
      return;
    }
    if (path === '/api/v1/projects') {
      await json(route, {
        data: [{ id: PROJECT_ID, name: 'A11y 项目', status: 'active', workspace_id: WORKSPACE_ID }],
        meta: REQUEST_META,
      });
      return;
    }
    if (path === '/api/v1/analytics/overview') {
      await json(route, {
        data: {
          data_updated_at: null,
          methodology_version: 'analytics-methodology@1',
          metrics: [],
          visibility: {
            average_rank: null,
            citation_count: 0,
            citation_rate: 0,
            observation_count: 0,
          },
        },
        meta: REQUEST_META,
      });
      return;
    }
    if (path === '/api/v1/analytics/platforms') {
      await json(route, {
        data: {
          data_updated_at: null,
          methodology_version: 'analytics-methodology@1',
          platforms: [],
        },
        meta: REQUEST_META,
      });
      return;
    }
    if (path === '/api/v1/analytics/costs') {
      await json(route, { data: emptyCosts(), meta: REQUEST_META });
      return;
    }
    if (path === '/api/v1/analytics/costs/budget') {
      await json(route, {
        data: {
          consumed_cents: 0,
          currency: 'CNY',
          hard_limit: false,
          is_exceeded: false,
          is_exhausted: false,
          limit_cents: null,
          month: '2026-07',
          remaining_cents: null,
          workspace_id: WORKSPACE_ID,
        },
        meta: REQUEST_META,
      });
      return;
    }
    if (path === '/api/v1/visibility-observations/trend') {
      await json(route, { data: [], meta: REQUEST_META });
      return;
    }
    if (
      path === '/api/v1/memberships' ||
      path === '/api/v1/invitations' ||
      path === '/api/v1/platform/prompt-versions' ||
      path === '/api/v1/platform/rule-versions' ||
      path === '/api/v1/audit-events' ||
      path === '/api/v1/platform/tenants'
    ) {
      await json(route, { data: { items: [], next_cursor: null }, meta: REQUEST_META });
      return;
    }

    await json(route, { data: [], meta: REQUEST_META });
  });
  return Object.freeze({ writeRequests: () => Object.freeze([...writeRequests]) });
}

function tenantChoice() {
  return {
    id: TENANT_ID,
    is_active: true,
    last_used_at: null,
    name: 'A11y 企业',
    role_code: 'tenant_owner',
    slug: 'a11y-tenant',
  };
}

function workspace() {
  return {
    created_at: '2026-07-01T00:00:00.000Z',
    id: WORKSPACE_ID,
    name: 'A11y 工作区',
    settings: {
      budget_policy: { hard_limit: false, monthly_limit_cny: null },
      default_platform_codes: ['official_site'],
      review_policy: { minimum_approvals: 1, require_high_risk_signoff: false },
      schema_version: 'workspace-settings@1',
    },
    slug: 'a11y-workspace',
    status: 'active',
    tenant_id: TENANT_ID,
    timezone: 'Asia/Shanghai',
    updated_at: '2026-07-16T00:00:00.000Z',
    version: 1,
  };
}

function emptyCosts() {
  return { breakdown: [], package_totals: [], settled_only: true, totals: [] };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}
