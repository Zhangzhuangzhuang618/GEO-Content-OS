import sharp from 'sharp';

import type { DouyinNoteCardInput } from './types.js';

const WIDTH = 1_080;
const HEIGHT = 1_440;
const FONT_FAMILY = 'Noto Sans CJK SC, PingFang SC, Microsoft YaHei, sans-serif';
const CLOSING_PUNCTUATION = /^[，。！？；：、）》】」』〕,.!?;:)]+$/u;
const OPENING_PUNCTUATION_AT_END = /[（《【「『〔(]+$/u;
const WORD_SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'word' });

export async function renderDouyinNoteCard(input: DouyinNoteCardInput): Promise<Uint8Array> {
  validateInput(input);
  const background = input.background ? await backgroundForRendering(input.background) : null;
  const svg = Buffer.from(cardSvg(input, Boolean(background)));
  const pipeline = background
    ? sharp(background).composite([{ blend: 'over', input: svg }])
    : sharp(svg);
  return Uint8Array.from(
    await pipeline.jpeg({ chromaSubsampling: '4:4:4', mozjpeg: true, quality: 92 }).toBuffer(),
  );
}

async function backgroundForRendering(body: Uint8Array): Promise<Uint8Array> {
  if (body.byteLength < 128 || body.byteLength > 10_000_000) {
    throw new Error('Douyin note background size is outside the allowed range');
  }
  const metadata = await sharp(body, { failOn: 'error' }).metadata();
  if (
    metadata.format === 'jpeg' &&
    metadata.width === WIDTH &&
    metadata.height === HEIGHT &&
    (metadata.orientation === undefined || metadata.orientation === 1)
  ) {
    return body;
  }
  return normalizeDouyinNoteBackground(body);
}

export async function normalizeDouyinNoteBackground(body: Uint8Array): Promise<Uint8Array> {
  if (body.byteLength < 128 || body.byteLength > 10_000_000) {
    throw new Error('Douyin note background size is outside the allowed range');
  }
  return Uint8Array.from(
    await sharp(body, { failOn: 'error' })
      .rotate()
      .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'attention' })
      .jpeg({ chromaSubsampling: '4:4:4', mozjpeg: true, quality: 90 })
      .toBuffer(),
  );
}

function cardSvg(input: DouyinNoteCardInput, hasBackground: boolean): string {
  if (input.layout === 'legacy') return legacySvg(input);
  if (input.layout === 'cover') return coverSvg(input, hasBackground);
  if (input.layout === 'photo') return photoSvg(input);
  if (input.layout === 'summary') return summarySvg(input);
  return editorialSvg(input);
}

function legacySvg(input: DouyinNoteCardInput): string {
  const palette = palettes(input.kind, input.index);
  const headingFont = input.kind === 'cover' ? 86 : 70;
  const headingLines = wrapDouyinNoteHeading(input.heading, input.kind);
  if (headingLines.length > (input.kind === 'cover' ? 4 : 3)) {
    throw new Error('Douyin note card heading exceeds the deterministic layout');
  }
  const headingTop = input.kind === 'cover' ? 270 : 260;
  const headingLineHeight = headingFont * 1.28;
  const bodyFont =
    weightedLength(input.body) > 190 ? 40 : weightedLength(input.body) > 140 ? 44 : 48;
  const bodyLines = wrapDouyinNoteText(input.body, Math.floor(850 / bodyFont));
  const bodyTop = Math.max(
    input.kind === 'cover' ? 720 : 580,
    headingTop + headingLines.length * headingLineHeight + (input.kind === 'cover' ? 90 : 60),
  );
  const bodyLineHeight = bodyFont * 1.5;
  const maximumBodyLines = Math.floor((1_260 - bodyTop) / bodyLineHeight) + 1;
  if (bodyLines.length > maximumBodyLines) {
    throw new Error('Douyin note card body exceeds the deterministic layout');
  }
  const eyebrow =
    input.kind === 'cover' ? '实用图文指南' : input.kind === 'summary' ? '要点回顾' : '实用提示';
  return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="legacy-bg" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="${palette[0]}"/>
        <stop offset="1" stop-color="${palette[1]}"/>
      </linearGradient>
      <filter id="legacy-shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="18" stdDeviation="28" flood-color="#0f172a" flood-opacity="0.16"/>
      </filter>
    </defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#legacy-bg)"/>
    <circle cx="960" cy="110" r="300" fill="#ffffff" fill-opacity="0.14"/>
    <circle cx="60" cy="1370" r="360" fill="${palette[2]}" fill-opacity="0.22"/>
    <rect x="64" y="64" width="952" height="1312" rx="52" fill="#ffffff" fill-opacity="0.94" filter="url(#legacy-shadow)"/>
    <rect x="110" y="116" width="238" height="62" rx="31" fill="${palette[3]}"/>
    <text x="229" y="158" text-anchor="middle" fill="#ffffff" font-size="28" font-weight="600" font-family="${FONT_FAMILY}">${escapeXml(eyebrow)}</text>
    ${textLines(headingLines, 110, headingTop, headingFont, headingLineHeight, '700', '#0f172a')}
    <rect x="110" y="${Math.round(bodyTop - 48)}" width="86" height="8" rx="4" fill="${palette[3]}"/>
    ${textLines(bodyLines, 110, bodyTop, bodyFont, bodyLineHeight, '400', '#0f172a')}
    <text x="110" y="1320" fill="#64748b" font-size="25" font-family="${FONT_FAMILY}">${escapeXml(shortTitle(input.title))}</text>
    <text x="820" y="1320" text-anchor="end" fill="#64748b" font-size="25" font-family="${FONT_FAMILY}">${input.index + 1} / ${input.total}</text>
    <text x="970" y="1320" text-anchor="end" fill="#94a3b8" font-size="18" font-family="${FONT_FAMILY}">AI辅助制作</text>
  </svg>`;
}

function coverSvg(input: DouyinNoteCardInput, hasBackground: boolean): string {
  const headingLines = wrapDouyinNoteHeading(input.heading, 'cover');
  const bodyLines = wrapDouyinNoteText(input.body, 19);
  if (headingLines.length > 3 || bodyLines.length > 3) {
    throw new Error('Douyin note card text exceeds the deterministic layout');
  }
  const palette = palettes(input.kind, input.index);
  const headingTop = hasBackground ? 760 : 360;
  const bodyTop = headingTop + headingLines.length * 100 + 58;
  return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="cover-bg" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="#0f172a"/>
        <stop offset="0.58" stop-color="${palette[0]}"/>
        <stop offset="1" stop-color="${palette[1]}"/>
      </linearGradient>
      <linearGradient id="cover-shade" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="#020617" stop-opacity="0.08"/>
        <stop offset="0.48" stop-color="#020617" stop-opacity="0.22"/>
        <stop offset="1" stop-color="#020617" stop-opacity="0.9"/>
      </linearGradient>
    </defs>
    ${hasBackground ? '<rect width="1080" height="1440" fill="url(#cover-shade)"/>' : `<rect width="1080" height="1440" fill="url(#cover-bg)"/><circle cx="930" cy="180" r="340" fill="#ffffff" fill-opacity="0.08"/><path d="M-40 1180 C260 900 580 1080 1120 690 L1120 1440 L-40 1440 Z" fill="#ffffff" fill-opacity="0.06"/>`}
    ${pill('实用解决方案', 72, 72, hasBackground ? '#ffffff' : palette[3], hasBackground ? '#0f172a' : '#ffffff')}
    ${textLines(headingLines, 72, headingTop, 80, 100, '800', '#ffffff')}
    <rect x="72" y="${Math.round(bodyTop - 46)}" width="92" height="8" rx="4" fill="${palette[2]}"/>
    ${textLines(bodyLines, 72, bodyTop, 38, 56, '500', '#f8fafc')}
    ${footer(input, '#e2e8f0', hasBackground ? 'AI示意图' : 'AI辅助制作')}
  </svg>`;
}

function photoSvg(input: DouyinNoteCardInput): string {
  const headingLines = wrapDouyinNoteHeading(input.heading, 'body');
  const bodyLines = wrapDouyinNoteText(input.body, 21);
  if (headingLines.length > 2 || bodyLines.length > 5) {
    throw new Error('Douyin note card text exceeds the deterministic layout');
  }
  const bodyTop = 824 + headingLines.length * 80 + 66;
  const palette = palettes(input.kind, input.index);
  return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="photo-shade" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="#020617" stop-opacity="0.08"/>
        <stop offset="0.62" stop-color="#020617" stop-opacity="0.16"/>
        <stop offset="1" stop-color="#020617" stop-opacity="0.58"/>
      </linearGradient>
      <filter id="panel-shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="18" stdDeviation="30" flood-color="#0f172a" flood-opacity="0.2"/>
      </filter>
    </defs>
    <rect width="1080" height="850" fill="url(#photo-shade)"/>
    ${pill(`第 ${input.index + 1} 页`, 64, 64, '#ffffff', '#0f172a')}
    ${pill('AI示意图', 820, 64, '#0f172a', '#ffffff')}
    <rect x="48" y="690" width="984" height="702" rx="50" fill="#ffffff" fill-opacity="0.97" filter="url(#panel-shadow)"/>
    <rect x="92" y="756" width="86" height="8" rx="4" fill="${palette[3]}"/>
    ${textLines(headingLines, 92, 824, 64, 80, '800', '#0f172a')}
    ${textLines(bodyLines, 92, bodyTop, 38, 56, '450', '#334155')}
    ${footer(input, '#64748b', 'AI示意图')}
  </svg>`;
}

function editorialSvg(input: DouyinNoteCardInput): string {
  const palette = palettes(input.kind, input.index);
  const headingLines = wrapDouyinNoteHeading(input.heading, 'body');
  if (headingLines.length > 2) {
    throw new Error('Douyin note card heading exceeds the deterministic layout');
  }
  const body =
    input.layout === 'checklist'
      ? checklistBody(input.body, palette[3])
      : focusBody(input.body, palette[3]);
  return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="editorial-bg" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="${palette[0]}"/>
        <stop offset="1" stop-color="${palette[1]}"/>
      </linearGradient>
      <filter id="editorial-shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="18" stdDeviation="30" flood-color="#0f172a" flood-opacity="0.12"/>
      </filter>
    </defs>
    <rect width="1080" height="1440" fill="url(#editorial-bg)"/>
    <circle cx="950" cy="120" r="290" fill="#ffffff" fill-opacity="0.16"/>
    <rect x="52" y="52" width="976" height="1336" rx="48" fill="#ffffff" fill-opacity="0.96" filter="url(#editorial-shadow)"/>
    <text x="92" y="172" fill="${palette[3]}" font-size="36" font-weight="800" font-family="${FONT_FAMILY}">${String(input.index + 1).padStart(2, '0')}</text>
    <text x="182" y="172" fill="#64748b" font-size="27" font-weight="600" font-family="${FONT_FAMILY}">${input.layout === 'checklist' ? '逐项核对' : '关键判断'}</text>
    ${textLines(headingLines, 92, 330, 72, 92, '800', '#0f172a')}
    <rect x="92" y="${330 + headingLines.length * 92 + 22}" width="90" height="8" rx="4" fill="${palette[3]}"/>
    ${body}
    ${footer(input, '#64748b', 'AI辅助制作')}
  </svg>`;
}

function summarySvg(input: DouyinNoteCardInput): string {
  const headingLines = wrapDouyinNoteHeading(input.heading, 'summary');
  if (headingLines.length > 2) {
    throw new Error('Douyin note card heading exceeds the deterministic layout');
  }
  const body = checklistBody(input.body, '#38bdf8', 600, '#f8fafc');
  return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="summary-bg" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="#0f172a"/>
        <stop offset="0.56" stop-color="#1e3a8a"/>
        <stop offset="1" stop-color="#0f766e"/>
      </linearGradient>
    </defs>
    <rect width="1080" height="1440" fill="url(#summary-bg)"/>
    <circle cx="930" cy="170" r="330" fill="#ffffff" fill-opacity="0.08"/>
    ${pill('收藏前再看一遍', 72, 72, '#ffffff', '#0f172a')}
    ${textLines(headingLines, 72, 330, 78, 98, '800', '#ffffff')}
    <rect x="72" y="${330 + headingLines.length * 98 + 24}" width="90" height="8" rx="4" fill="#38bdf8"/>
    ${body}
    ${footer(input, '#dbeafe', 'AI辅助制作')}
  </svg>`;
}

function focusBody(value: string, accent: string): string {
  const lines = wrapDouyinNoteText(value, 19);
  if (lines.length > 6) throw new Error('Douyin note card body exceeds the deterministic layout');
  return `<rect x="92" y="610" width="896" height="490" rx="36" fill="${accent}" fill-opacity="0.08"/>
    <text x="126" y="708" fill="${accent}" font-size="84" font-weight="800" font-family="${FONT_FAMILY}">“</text>
    ${textLines(lines, 146, 790, 45, 70, '500', '#334155')}`;
}

function checklistBody(value: string, accent: string, top = 600, textColor = '#334155'): string {
  const items = splitChecklistItems(value);
  const rendered: string[] = [];
  let y = top;
  let totalLines = 0;
  for (const [index, item] of items.entries()) {
    const lines = wrapDouyinNoteText(item, 18.5);
    totalLines += lines.length;
    if (lines.length > 3 || totalLines > 7) {
      throw new Error('Douyin note card body exceeds the deterministic layout');
    }
    rendered.push(
      `<circle cx="120" cy="${y - 12}" r="26" fill="${accent}"/><text x="120" y="${y - 2}" text-anchor="middle" fill="#ffffff" font-size="24" font-weight="700" font-family="${FONT_FAMILY}">${index + 1}</text>`,
    );
    rendered.push(textLines(lines, 172, y, 42, 62, '500', textColor));
    y += Math.max(108, lines.length * 62 + 44);
  }
  if (y > 1_270) throw new Error('Douyin note card body exceeds the deterministic layout');
  return rendered.join('');
}

function splitChecklistItems(value: string): readonly string[] {
  const items = value
    .trim()
    .split(/(?:\r?\n)+|(?<=[。！？；])/u)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length >= 2) return Object.freeze(items);
  const lines = wrapDouyinNoteText(value, 22);
  return Object.freeze(lines.length > 1 ? lines : [value.trim()]);
}

function validateInput(input: DouyinNoteCardInput): void {
  const correctLayout =
    input.layout === 'legacy' ||
    (input.kind === 'cover' && input.layout === 'cover') ||
    (input.kind === 'summary' && input.layout === 'summary') ||
    (input.kind === 'body' && ['checklist', 'focus', 'photo'].includes(input.layout));
  if (
    !Number.isInteger(input.index) ||
    !Number.isInteger(input.total) ||
    input.index < 0 ||
    input.total < 5 ||
    input.total > 10 ||
    input.index >= input.total ||
    !input.title.trim() ||
    !input.heading.trim() ||
    !input.body.trim() ||
    !correctLayout ||
    (input.layout === 'photo' && !input.background) ||
    (input.background && input.layout !== 'cover' && input.layout !== 'photo')
  ) {
    throw new Error('Douyin note card input is invalid');
  }
}

function palettes(
  kind: DouyinNoteCardInput['kind'],
  index: number,
): readonly [string, string, string, string] {
  if (kind === 'cover') return ['#172554', '#1d4ed8', '#60a5fa', '#2563eb'];
  if (kind === 'summary') return ['#0f172a', '#0f766e', '#38bdf8', '#0f766e'];
  const options = [
    ['#fff7ed', '#fffbeb', '#f59e0b', '#b45309'],
    ['#eef2ff', '#f5f3ff', '#8b5cf6', '#6d28d9'],
    ['#ecfeff', '#f0fdfa', '#14b8a6', '#0f766e'],
    ['#eff6ff', '#f8fafc', '#3b82f6', '#1d4ed8'],
  ] as const;
  return options[index % options.length]!;
}

function pill(label: string, x: number, y: number, fill: string, textColor: string): string {
  const width = Math.max(190, [...label].length * 34 + 64);
  return `<rect x="${x}" y="${y}" width="${width}" height="64" rx="32" fill="${fill}" fill-opacity="0.9"/><text x="${x + width / 2}" y="${y + 43}" text-anchor="middle" fill="${textColor}" font-size="27" font-weight="700" font-family="${FONT_FAMILY}">${escapeXml(label)}</text>`;
}

function footer(input: DouyinNoteCardInput, color: string, disclosure: string): string {
  return `<text x="72" y="1340" fill="${color}" font-size="24" font-family="${FONT_FAMILY}">${escapeXml(shortTitle(input.title))}</text>
    <text x="820" y="1340" text-anchor="end" fill="${color}" font-size="24" font-family="${FONT_FAMILY}">${input.index + 1} / ${input.total}</text>
    <text x="1008" y="1340" text-anchor="end" fill="${color}" font-size="18" font-family="${FONT_FAMILY}">${escapeXml(disclosure)}</text>`;
}

function textLines(
  lines: readonly string[],
  x: number,
  y: number,
  fontSize: number,
  lineHeight: number,
  weight: string,
  color: string,
): string {
  return lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${Math.round(y + index * lineHeight)}" fill="${color}" font-size="${fontSize}" font-weight="${weight}" font-family="${FONT_FAMILY}">${escapeXml(line)}</text>`,
    )
    .join('');
}

export function wrapDouyinNoteText(value: string, maximumUnits: number): readonly string[] {
  const lines: string[] = [];
  for (const paragraph of value.trim().split(/\r?\n/u)) {
    const normalized = paragraph.trim();
    if (!normalized) continue;
    let line = '';
    let units = 0;
    for (const segment of wrapSegments(normalized)) {
      const next = weightedLength(segment);
      if (line && units + next > maximumUnits && CLOSING_PUNCTUATION.test(segment)) {
        line += segment;
        units += next;
        continue;
      }
      if (line && units + next > maximumUnits) {
        const opener = OPENING_PUNCTUATION_AT_END.exec(line)?.[0] ?? '';
        const retained = opener ? line.slice(0, -opener.length).trimEnd() : line.trim();
        if (retained) lines.push(retained);
        line = `${opener}${segment}`;
        units = weightedLength(line);
        continue;
      }
      line += segment;
      units += next;
    }
    if (line.trim()) lines.push(line.trim());
  }
  return Object.freeze(lines);
}

export function wrapDouyinNoteHeading(
  value: string,
  kind: DouyinNoteCardInput['kind'],
): readonly string[] {
  const maximumUnits = kind === 'cover' ? 10.5 : 13;
  const lines = [...wrapDouyinNoteText(value, maximumUnits)];
  if (kind !== 'cover' || lines.length < 2) {
    return Object.freeze(lines);
  }

  const previous = [...(lines.at(-2) ?? '')];
  const final = [...(lines.at(-1) ?? '')];
  while (previous.length > 1 && weightedLength(final.join('')) < 4) {
    final.unshift(previous.pop()!);
  }
  if (/^[\p{L}\p{N}]$/u.test(previous.at(-1) ?? '') && /^\P{ASCII}$/u.test(final[0] ?? '')) {
    while (/^\p{ASCII}$/u.test(previous.at(-1) ?? '')) {
      final.unshift(previous.pop()!);
    }
  }
  lines.splice(-2, 2, previous.join('').trim(), final.join('').trim());
  return Object.freeze(lines);
}

function wrapSegments(value: string): readonly string[] {
  const segments: string[] = [];
  for (const item of WORD_SEGMENTER.segment(value)) {
    const segment = item.segment;
    const previous = segments.at(-1);
    if (
      previous &&
      /^[\p{Script=Han}]+$/u.test(previous) &&
      /^[\p{Script=Han}]+$/u.test(segment) &&
      weightedLength(`${previous}${segment}`) <= 4
    ) {
      segments[segments.length - 1] = `${previous}${segment}`;
    } else {
      segments.push(segment);
    }
  }
  return Object.freeze(segments);
}

function weightedLength(value: string): number {
  return [...value].reduce((total, character) => total + characterUnits(character), 0);
}

function characterUnits(character: string): number {
  if (/\s/u.test(character)) return 0.32;
  if ((character.codePointAt(0) ?? 0x80) <= 0x7f) return 0.56;
  return 1;
}

function shortTitle(value: string): string {
  const characters = [...value.trim()];
  return characters.length <= 20 ? value.trim() : `${characters.slice(0, 19).join('')}…`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
