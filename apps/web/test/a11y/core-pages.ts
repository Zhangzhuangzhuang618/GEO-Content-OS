export interface CorePage {
  readonly code: string;
  readonly path: string;
}

const SOURCE_ID = '10000000-0000-4000-8000-000000000140';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000140';
const PROJECT_ID = '30000000-0000-4000-8000-000000000140';
const RESOURCE_ID = '40000000-0000-4000-8000-000000000140';

export const CORE_PAGES: readonly CorePage[] = Object.freeze([
  { code: 'AUTH-01', path: '/auth-01' },
  { code: 'AUTH-02', path: '/auth-02' },
  { code: 'DASH-01', path: '/dash-01' },
  { code: 'STR-01', path: '/str-01' },
  { code: 'STR-02', path: '/str-02' },
  { code: 'STR-03', path: '/str-03' },
  { code: 'STR-04', path: '/str-04' },
  { code: 'KNOW-01', path: '/know-01' },
  { code: 'KNOW-02', path: '/know-02' },
  {
    code: 'KNOW-03',
    path: `/know-03?id=${SOURCE_ID}&workspace_id=${WORKSPACE_ID}&project_id=${PROJECT_ID}`,
  },
  { code: 'KNOW-04', path: '/know-04' },
  { code: 'CONT-01', path: '/cont-01' },
  { code: 'CONT-02', path: '/cont-02' },
  { code: 'CONT-03', path: '/cont-03' },
  { code: 'CONT-04', path: `/cont-04?id=${RESOURCE_ID}` },
  { code: 'CONT-05', path: `/cont-05?id=${RESOURCE_ID}` },
  { code: 'CONT-06', path: `/cont-06?id=${RESOURCE_ID}` },
  { code: 'QUAL-01', path: `/qual-01?id=${RESOURCE_ID}` },
  { code: 'REV-01', path: '/rev-01' },
  { code: 'REV-02', path: `/rev-02?id=${RESOURCE_ID}` },
  { code: 'PUB-01', path: '/pub-01' },
  { code: 'PUB-02', path: '/pub-02' },
  { code: 'PUB-03', path: `/pub-03?id=${RESOURCE_ID}` },
  { code: 'ANL-01', path: '/anl-01' },
  { code: 'ANL-02', path: '/anl-02' },
  { code: 'ANL-03', path: '/anl-03' },
  { code: 'ANL-04', path: `/anl-04?workspace_id=${WORKSPACE_ID}` },
  { code: 'SET-01', path: '/set-01' },
  { code: 'SET-02', path: `/set-02?id=${WORKSPACE_ID}` },
  { code: 'SET-03', path: '/set-03' },
  { code: 'SET-04', path: '/set-04' },
  { code: 'PLAT-01', path: '/plat-01' },
]);

if (CORE_PAGES.length !== 32 || new Set(CORE_PAGES.map((page) => page.code)).size !== 32) {
  throw new Error('the frozen core-page manifest must contain exactly 32 unique page codes');
}
