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
  const heading = textLines(headingLines, 110, headingTop, headingFont, headingLineHeight, '700');
  const body = textLines(bodyLines, 110, bodyTop, bodyFont, bodyLineHeight, '400');
  const eyebrow =
    input.kind === 'cover' ? '实用图文指南' : input.kind === 'summary' ? '要点回顾' : '实用提示';
  const svg = Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="${palette[0]}"/>
          <stop offset="1" stop-color="${palette[1]}"/>
        </linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="18" stdDeviation="28" flood-color="#0f172a" flood-opacity="0.16"/>
        </filter>
      </defs>
      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
      <circle cx="960" cy="110" r="300" fill="#ffffff" fill-opacity="0.14"/>
      <circle cx="60" cy="1370" r="360" fill="${palette[2]}" fill-opacity="0.22"/>
      <rect x="64" y="64" width="952" height="1312" rx="52" fill="#ffffff" fill-opacity="0.94" filter="url(#shadow)"/>
      <rect x="110" y="116" width="238" height="62" rx="31" fill="${palette[3]}"/>
      <text x="229" y="158" text-anchor="middle" fill="#ffffff" font-size="28" font-weight="600" font-family="${FONT_FAMILY}">${escapeXml(eyebrow)}</text>
      ${heading}
      <rect x="110" y="${Math.round(bodyTop - 48)}" width="86" height="8" rx="4" fill="${palette[3]}"/>
      ${body}
      <text x="110" y="1320" fill="#64748b" font-size="25" font-family="${FONT_FAMILY}">${escapeXml(shortTitle(input.title))}</text>
      <text x="820" y="1320" text-anchor="end" fill="#64748b" font-size="25" font-family="${FONT_FAMILY}">${input.index + 1} / ${input.total}</text>
      <text x="970" y="1320" text-anchor="end" fill="#94a3b8" font-size="18" font-family="${FONT_FAMILY}">AI辅助制作</text>
    </svg>`);
  return Uint8Array.from(
    await sharp(svg).jpeg({ chromaSubsampling: '4:4:4', mozjpeg: true, quality: 92 }).toBuffer(),
  );
}

function validateInput(input: DouyinNoteCardInput): void {
  if (
    !Number.isInteger(input.index) ||
    !Number.isInteger(input.total) ||
    input.index < 0 ||
    input.total < 5 ||
    input.total > 10 ||
    input.index >= input.total ||
    !input.title.trim() ||
    !input.heading.trim() ||
    !input.body.trim()
  ) {
    throw new Error('Douyin note card input is invalid');
  }
}

function palettes(
  kind: DouyinNoteCardInput['kind'],
  index: number,
): readonly [string, string, string, string] {
  if (kind === 'cover') return ['#dbeafe', '#eff6ff', '#60a5fa', '#2563eb'];
  if (kind === 'summary') return ['#dcfce7', '#f0fdf4', '#4ade80', '#15803d'];
  const options = [
    ['#fef3c7', '#fffbeb', '#fbbf24', '#b45309'],
    ['#ede9fe', '#f5f3ff', '#a78bfa', '#7c3aed'],
    ['#cffafe', '#ecfeff', '#22d3ee', '#0e7490'],
  ] as const;
  return options[index % options.length]!;
}

function textLines(
  lines: readonly string[],
  x: number,
  y: number,
  fontSize: number,
  lineHeight: number,
  weight: string,
): string {
  return lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${Math.round(y + index * lineHeight)}" fill="#0f172a" font-size="${fontSize}" font-weight="${weight}" font-family="${FONT_FAMILY}">${escapeXml(line)}</text>`,
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
