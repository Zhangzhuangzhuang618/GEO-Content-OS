import { z } from 'zod';

export const OfficialSiteServicePhoneSchema = z
  .string()
  .trim()
  .regex(
    /^(?:1[3-9]\d{9}|0\d{9,11}|(?:400|800)\d{7})$/u,
    '官网服务电话必须是中国大陆手机号、座机、400 或 800 电话，且不含空格和连字符。',
  );

interface ContentBlockLike {
  readonly block_key: string;
  readonly block_type: string;
  readonly text: string;
}

interface CitationMapLike {
  readonly claim_key: string;
}

interface OfficialSiteContentLike {
  readonly blocks: readonly ContentBlockLike[];
  readonly citation_map?: readonly CitationMapLike[];
  readonly cta?: unknown;
  readonly platform_code?: unknown;
}

const CTA_MAX_CHARACTERS = 200;
const PHONE_IN_CONTENT_PATTERN =
  /(?<!\d)(?:(?:\+?86[-\s]?)?1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8}|(?:400|800)[-\s]?\d{3}[-\s]?\d{4})(?!\d)/gu;
const MACHINE_IDENTIFIER_KEY_PATTERN = /(?:^|_)(?:hash|id|ids|key|version)$/u;
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const HTTP_URL_PATTERN = /https?:\/\/[^\s"<>]+/giu;

export function applyOfficialSiteServicePhone<T extends OfficialSiteContentLike>(
  content: T,
  servicePhone: string,
): T {
  if (content.platform_code !== 'official_site') return content;
  const phone = OfficialSiteServicePhoneSchema.parse(servicePhone);
  const ctaBlocks = content.blocks.filter((block) => block.block_type === 'cta');
  const preservedBlocks = content.blocks.filter((block) => block.block_type !== 'cta');
  const existingCta =
    typeof content.cta === 'string' && content.cta.trim()
      ? content.cta.trim()
      : (ctaBlocks.find((block) => block.text.trim())?.text.trim() ?? '');
  const removedBlockKeys = new Set(ctaBlocks.map((block) => block.block_key));
  const citationMap = content.citation_map?.filter(
    (mapping) => !removedBlockKeys.has(mapping.claim_key),
  );
  return {
    ...content,
    blocks: Object.freeze([...preservedBlocks]),
    ...(citationMap ? { citation_map: Object.freeze([...citationMap]) } : {}),
    cta: officialSiteServiceCta(existingCta, phone),
  } as T;
}

export function officialSiteServiceCta(existingCta: string | null, servicePhone: string): string {
  const phone = OfficialSiteServicePhoneSchema.parse(servicePhone);
  const base = (existingCta ?? '').trim();
  let replacedPhone = false;
  const normalizedBase = base.replace(PHONE_IN_CONTENT_PATTERN, () => {
    if (replacedPhone) return '';
    replacedPhone = true;
    return phone;
  });
  if (
    replacedPhone &&
    countOccurrences(normalizedBase, phone) === 1 &&
    [...normalizedBase].length <= CTA_MAX_CHARACTERS
  ) {
    return normalizedBase;
  }
  const suffix = `联系电话：${phone}。`;
  const baseWithoutPhone = base.replace(PHONE_IN_CONTENT_PATTERN, '').trim();
  if (!baseWithoutPhone) return `如需咨询服务，请致电 ${phone}。`;
  const separator = /[。！？；;,.，!?]$/u.test(baseWithoutPhone) ? ' ' : '；';
  const available = CTA_MAX_CHARACTERS - [...`${separator}${suffix}`].length;
  return `${truncate(baseWithoutPhone, Math.max(0, available)).trim()}${separator}${suffix}`;
}

export function hasExactOfficialSiteServicePhone(content: unknown, servicePhone: unknown): boolean {
  const parsedPhone = OfficialSiteServicePhoneSchema.safeParse(servicePhone);
  if (!parsedPhone.success || !isRecord(content)) return false;
  const cta = content['cta'];
  if (typeof cta !== 'string' || !cta.includes(parsedPhone.data)) return false;
  const phones = findPhoneNumbers(content);
  return phones.length === 1 && phones[0] === parsedPhone.data;
}

export function readOfficialSiteServicePhone(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  const parsed = OfficialSiteServicePhoneSchema.safeParse(
    settings?.['official_site_service_phone'],
  );
  return parsed.success ? parsed.data : null;
}

function truncate(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join('');
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

function findPhoneNumbers(value: unknown): readonly string[] {
  return Object.freeze(collectPhoneNumbers(value));
}

function collectPhoneNumbers(value: unknown, key = ''): string[] {
  if (MACHINE_IDENTIFIER_KEY_PATTERN.test(key) || key === '@id' || key === 'platform_code') {
    return [];
  }
  if (typeof value === 'string') {
    const publishableText = value.replace(UUID_PATTERN, '').replace(HTTP_URL_PATTERN, '');
    return [...publishableText.matchAll(PHONE_IN_CONTENT_PATTERN)].map((match) =>
      normalizePhone(match[0]),
    );
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPhoneNumbers(item, key));
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([entryKey, entryValue]) =>
    collectPhoneNumbers(entryValue, entryKey),
  );
}

function normalizePhone(value: string): string {
  const compact = value.replace(/[-\s]/gu, '');
  return compact.replace(/^\+?86(?=1[3-9]\d{9}$)/u, '');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
