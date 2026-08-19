import { lookup as systemLookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import http, { type IncomingMessage, type RequestOptions } from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { TextDecoder } from 'node:util';

import type { WebFetchConfiguration } from './web-fetch.config.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_CONTENT_TYPES = new Set(['application/xhtml+xml', 'text/html', 'text/plain']);
const JSON_CONTENT_TYPES = new Set(['application/json', 'text/json']);
const CCB_CONTENT_HOST = 'ibuy.ccb.com';
const CCB_CONTENT_PATH = '/cms/index.html';
const CCB_INDEX_PAGE_SIZE = 1_000;
const CCB_MAX_INDEX_PAGES = 20;
const BLOCKED_HOST_SUFFIXES = [
  'internal',
  'invalid',
  'lan',
  'local',
  'localhost',
  'onion',
  'test',
] as const;
const NETWORK_BLOCK_LIST = buildNetworkBlockList();

export interface WebFetchResult {
  readonly body: Buffer;
  readonly contentHash: string;
  readonly contentType: string;
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
  readonly statusCode: number;
}

export interface WebFetchAdapter {
  fetch(url: string): Promise<WebFetchResult>;
}

export interface WebFetchDependencies {
  readonly lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly request?: (
    target: URL,
    pinnedAddress: ResolvedAddress,
    configuration: WebFetchConfiguration,
    timeoutMs: number,
  ) => Promise<RawResponse>;
}

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

interface RawResponse {
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly statusCode: number;
}

interface CcbContentRoute {
  readonly id: string;
  readonly pId: string;
  readonly sourceUrl: string;
}

export class WebFetchValidationError extends Error {
  public constructor(message = 'Web source URL is invalid') {
    super(message);
    this.name = 'WebFetchValidationError';
  }
}

export class WebFetchBlockedError extends Error {
  public constructor(message = 'Web source target is blocked by network policy') {
    super(message);
    this.name = 'WebFetchBlockedError';
  }
}

export class WebFetchSizeError extends Error {
  public constructor() {
    super('Web source response exceeds the configured size limit');
    this.name = 'WebFetchSizeError';
  }
}

export class WebFetchTimeoutError extends Error {
  public constructor() {
    super('Web source fetch exceeded the configured timeout');
    this.name = 'WebFetchTimeoutError';
  }
}

export class WebFetchResponseError extends Error {
  public constructor(message = 'Web source returned an unsupported response') {
    super(message);
    this.name = 'WebFetchResponseError';
  }
}

export class SafeWebFetchAdapter implements WebFetchAdapter {
  private readonly resolve: NonNullable<WebFetchDependencies['lookup']>;
  private readonly send: NonNullable<WebFetchDependencies['request']>;

  public constructor(
    private readonly configuration: WebFetchConfiguration,
    dependencies: WebFetchDependencies = {},
  ) {
    this.resolve = dependencies.lookup ?? resolveHostname;
    this.send = dependencies.request ?? requestOnce;
  }

  public async fetch(rawUrl: string): Promise<WebFetchResult> {
    const deadline = Date.now() + this.configuration.timeoutMs;
    const ccbContentRoute = parseCcbContentRoute(rawUrl);
    if (ccbContentRoute) return this.fetchCcbContent(ccbContentRoute, deadline);
    return this.fetchAllowedContent(rawUrl, deadline, ALLOWED_CONTENT_TYPES);
  }

  private async fetchAllowedContent(
    rawUrl: string,
    deadline: number,
    allowedContentTypes: ReadonlySet<string>,
  ): Promise<WebFetchResult> {
    let current = normalizeUrl(rawUrl);
    const redirects: string[] = [];
    const visited = new Set<string>();

    for (let redirectCount = 0; ; redirectCount += 1) {
      const normalized = current.toString();
      if (visited.has(normalized)) {
        throw new WebFetchResponseError('Web source redirect loop was detected');
      }
      visited.add(normalized);
      validateHostPolicy(current, this.configuration);
      const remainingBeforeDns = remainingTime(deadline);
      const addresses = await withTimeout(this.resolve(current.hostname), remainingBeforeDns);
      if (
        addresses.length === 0 ||
        addresses.some((entry) => !isPublicNetworkAddress(entry.address))
      ) {
        throw new WebFetchBlockedError();
      }
      const response = await this.send(
        current,
        addresses[0] as ResolvedAddress,
        this.configuration,
        remainingTime(deadline),
      );

      if (REDIRECT_STATUSES.has(response.statusCode)) {
        if (redirectCount >= this.configuration.maxRedirects) {
          throw new WebFetchResponseError('Web source exceeded the redirect limit');
        }
        const location = singleHeader(response.headers['location']);
        if (!location) throw new WebFetchResponseError('Web source redirect is missing Location');
        const next = normalizeUrl(location, current);
        if (current.protocol === 'https:' && next.protocol !== 'https:') {
          throw new WebFetchBlockedError('HTTPS web sources cannot redirect to HTTP');
        }
        redirects.push(next.toString());
        current = next;
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new WebFetchResponseError(`Web source returned HTTP ${response.statusCode}`);
      }
      if (response.body.byteLength > this.configuration.maxBytes) throw new WebFetchSizeError();
      const contentType = normalizeContentType(singleHeader(response.headers['content-type']));
      if (!allowedContentTypes.has(contentType)) {
        throw new WebFetchResponseError('Web source content type is not allowed');
      }
      if (response.body.byteLength === 0) {
        throw new WebFetchResponseError('Web source response body is empty');
      }
      return {
        body: response.body,
        contentHash: createHash('sha256').update(response.body).digest('hex'),
        contentType,
        finalUrl: current.toString(),
        redirectChain: Object.freeze(redirects),
        statusCode: response.statusCode,
      };
    }
  }

  private async fetchCcbContent(route: CcbContentRoute, deadline: number): Promise<WebFetchResult> {
    for (let page = 1; page <= CCB_MAX_INDEX_PAGES; page += 1) {
      const indexUrl = `https://${CCB_CONTENT_HOST}/json/contentFile/${route.pId}/${page}.json`;
      const index = await this.fetchAllowedContent(indexUrl, deadline, JSON_CONTENT_TYPES);
      const entries = parseCcbIndex(index.body);
      const match = entries.find((entry): entry is Readonly<Record<string, unknown>> =>
        isCcbIndexMatch(entry, route),
      );
      if (match) {
        const year = ccbReleaseYear(match['releaseDate']);
        const detailUrl = `https://${CCB_CONTENT_HOST}/json/contentFile/${route.pId}/${year}/${route.id}.json`;
        const response = await this.fetchAllowedContent(detailUrl, deadline, JSON_CONTENT_TYPES);
        const body = renderCcbDetail(response.body, route);
        if (body.byteLength > this.configuration.maxBytes) throw new WebFetchSizeError();
        return {
          body,
          contentHash: createHash('sha256').update(body).digest('hex'),
          contentType: 'text/html',
          finalUrl: route.sourceUrl,
          redirectChain: Object.freeze([]),
          statusCode: response.statusCode,
        };
      }
      if (entries.length < CCB_INDEX_PAGE_SIZE) break;
    }
    throw new WebFetchResponseError('CCB content route did not resolve to a public detail');
  }
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NETWORK_BLOCK_LIST.check(address, 'ipv4');
  if (family !== 6) return false;
  const first = Number.parseInt(address.split(':')[0] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && !NETWORK_BLOCK_LIST.check(address, 'ipv6');
}

function normalizeUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new WebFetchValidationError();
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new WebFetchValidationError('Only credential-free HTTP(S) URLs are allowed');
  }
  if (!url.hostname || url.href.length > 2_048) throw new WebFetchValidationError();
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }
  return url;
}

function parseCcbContentRoute(raw: string): CcbContentRoute | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  const targetPage =
    url.protocol === 'https:' &&
    hostname === CCB_CONTENT_HOST &&
    (url.port === '' || url.port === '443') &&
    url.pathname === CCB_CONTENT_PATH;
  if (!targetPage || !url.hash.startsWith('#/content')) return undefined;
  if (url.username || url.password || url.search) {
    throw new WebFetchValidationError('CCB content URL is invalid');
  }
  let route: URL;
  try {
    route = new URL(url.hash.slice(1), `https://${CCB_CONTENT_HOST}`);
  } catch {
    throw new WebFetchValidationError('CCB content URL is invalid');
  }
  const keys = [...route.searchParams.keys()];
  const pIds = route.searchParams.getAll('pId');
  const ids = route.searchParams.getAll('id');
  if (
    route.pathname !== '/content' ||
    route.hash ||
    keys.length !== 2 ||
    keys.some((key) => key !== 'pId' && key !== 'id') ||
    pIds.length !== 1 ||
    ids.length !== 1 ||
    !/^\d{1,10}$/u.test(pIds[0] ?? '') ||
    !/^\d{1,20}$/u.test(ids[0] ?? '')
  ) {
    throw new WebFetchValidationError('CCB content URL is invalid');
  }
  const pId = pIds[0] as string;
  const id = ids[0] as string;
  return {
    id,
    pId,
    sourceUrl: `https://${CCB_CONTENT_HOST}${CCB_CONTENT_PATH}#/content?pId=${pId}&id=${id}`,
  };
}

function parseCcbIndex(body: Uint8Array): readonly unknown[] {
  const parsed = parseJson(body, 'CCB content index');
  if (!Array.isArray(parsed)) {
    throw new WebFetchResponseError('CCB content index is invalid');
  }
  return parsed;
}

function isCcbIndexMatch(
  value: unknown,
  route: CcbContentRoute,
): value is Readonly<Record<string, unknown>> {
  return (
    isRecord(value) && String(value['id']) === route.id && String(value['channelId']) === route.pId
  );
}

function ccbReleaseYear(value: unknown): string {
  const match = typeof value === 'string' ? /^(\d{4})-/u.exec(value) : null;
  if (!match?.[1]) throw new WebFetchResponseError('CCB content release date is invalid');
  return match[1];
}

function renderCcbDetail(body: Uint8Array, route: CcbContentRoute): Buffer {
  const detail = parseJson(body, 'CCB content detail');
  if (
    !isRecord(detail) ||
    String(detail['id']) !== route.id ||
    typeof detail['title'] !== 'string' ||
    !detail['title'].trim() ||
    typeof detail['content'] !== 'string' ||
    !detail['content'].trim()
  ) {
    throw new WebFetchResponseError('CCB content detail is invalid');
  }
  const metadata = [
    ['发布时间', detail['releaseDate']],
    ['发布机构', detail['releaseInst']],
    ['所属机构', detail['ptInst']],
    ['地区', detail['area']],
  ]
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1]))
    .map(([label, value]) => `<p>${label}：${escapeHtml(value)}</p>`)
    .join('');
  return Buffer.from(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(detail['title'])}</title><link rel="canonical" href="${escapeHtml(route.sourceUrl)}"></head><body><main><article><h1>${escapeHtml(detail['title'])}</h1>${metadata}${detail['content']}</article></main></body></html>`,
    'utf8',
  );
}

function parseJson(body: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new WebFetchResponseError(`${label} is invalid`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function validateHostPolicy(url: URL, configuration: WebFetchConfiguration): void {
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!configuration.allowedPorts.includes(port)) throw new WebFetchBlockedError();
  if (isIP(host) !== 0 && !isPublicNetworkAddress(host)) throw new WebFetchBlockedError();
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    throw new WebFetchBlockedError();
  }
  if (configuration.deniedHosts.some((policy) => hostMatches(host, policy))) {
    throw new WebFetchBlockedError();
  }
  if (
    configuration.allowedHosts.length > 0 &&
    !configuration.allowedHosts.some((policy) => hostMatches(host, policy))
  ) {
    throw new WebFetchBlockedError();
  }
}

function hostMatches(host: string, policy: string): boolean {
  return host === policy || host.endsWith(`.${policy}`);
}

async function resolveHostname(hostname: string): Promise<readonly ResolvedAddress[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }];
  }
  const results = await systemLookup(hostname, { all: true, order: 'verbatim' });
  return results.map((result) => ({
    address: result.address,
    family: result.family === 6 ? 6 : 4,
  }));
}

async function requestOnce(
  target: URL,
  pinnedAddress: ResolvedAddress,
  configuration: WebFetchConfiguration,
  timeoutMs: number,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const options: RequestOptions = {
      agent: false,
      family: pinnedAddress.family,
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'accept-encoding': 'identity',
        'user-agent': configuration.userAgent,
      },
      lookup: (_hostname, _options, callback) => {
        callback(null, pinnedAddress.address, pinnedAddress.family);
      },
      maxHeaderSize: 16_384,
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    };
    const request = transport.request(target, options, (response) => {
      collectResponse(response, configuration.maxBytes).then(resolve, reject);
    });
    request.on('error', (error: Error & { readonly name?: string }) => {
      if (error.name === 'AbortError' || /abort|timeout/iu.test(error.message)) {
        reject(new WebFetchTimeoutError());
        return;
      }
      reject(new WebFetchResponseError('Web source request failed'));
    });
    request.end();
  });
}

async function collectResponse(response: IncomingMessage, maxBytes: number): Promise<RawResponse> {
  const contentLength = Number(singleHeader(response.headers['content-length']));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.destroy();
    throw new WebFetchSizeError();
  }
  const encoding = singleHeader(response.headers['content-encoding'])?.toLowerCase();
  if (encoding && encoding !== 'identity') {
    response.destroy();
    throw new WebFetchResponseError('Compressed web source responses are not accepted');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const rawChunk of response) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      response.destroy();
      throw new WebFetchSizeError();
    }
    chunks.push(chunk);
  }
  return {
    body: Buffer.concat(chunks, bytes),
    headers: response.headers,
    statusCode: response.statusCode ?? 0,
  };
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

function normalizeContentType(value: string | undefined): string {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || 'application/octet-stream';
}

function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new WebFetchTimeoutError();
  return remaining;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new WebFetchTimeoutError()), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildNetworkBlockList(): BlockList {
  const list = new BlockList();
  for (const [address, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(address, prefix, 'ipv4');
  }
  for (const [address, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const) {
    list.addSubnet(address, prefix, 'ipv6');
  }
  return list;
}
