import { createHash } from 'node:crypto';
import sharp from 'sharp';

import type { ImageInspectionResult, ImageMetadata, TemplateImageInput } from './types.js';

const WIDTH = 1_200;
const HEIGHT = 800;
const MAX_MEDIA_EDGE = 4_096;
const MAX_SOURCE_IMAGE_EDGE = 8_192;
const MAX_SOURCE_IMAGE_PIXELS = 50_000_000;
const MAX_MEDIA_BYTES = 10_000_000;
const MAX_SOURCE_IMAGE_BYTES = 25 * 1_024 * 1_024;
const MEDIA_GATE_ERROR = 'Image dimensions, format, or size failed the media gate';

export async function normalizeGeneratedImage(body: Uint8Array): Promise<Uint8Array> {
  if (body.byteLength < 128 || body.byteLength > 10_000_000) {
    throw new Error('Generated image size is outside the allowed range');
  }
  return Uint8Array.from(
    await sharp(body, { failOn: 'error' })
      .rotate()
      .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'attention' })
      .jpeg({ chromaSubsampling: '4:4:4', mozjpeg: true, quality: 88 })
      .toBuffer(),
  );
}

export async function normalizePublishedSourceImage(body: Uint8Array): Promise<Uint8Array> {
  if (body.byteLength < 128 || body.byteLength > 25 * 1024 * 1024) {
    throw new Error('Source image size is outside the allowed range');
  }
  return Uint8Array.from(
    await sharp(body, { failOn: 'error' })
      .rotate()
      .resize(WIDTH, HEIGHT, {
        background: '#ffffff',
        fit: 'contain',
        position: 'centre',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ chromaSubsampling: '4:4:4', mozjpeg: true, quality: 92 })
      .toBuffer(),
  );
}

export async function applyAiDisclosure(body: Uint8Array): Promise<Uint8Array> {
  const label = Buffer.from(`
    <svg width="250" height="72" xmlns="http://www.w3.org/2000/svg">
      <rect width="250" height="72" rx="20" fill="#111827" fill-opacity="0.82"/>
      <text x="125" y="47" text-anchor="middle" fill="#ffffff" font-size="28"
        font-family="Noto Sans CJK SC, PingFang SC, Microsoft YaHei, sans-serif">AI示意图</text>
    </svg>`);
  return Uint8Array.from(
    await sharp(body)
      .composite([
        { blend: 'over', gravity: 'southeast', input: label, top: HEIGHT - 96, left: WIDTH - 278 },
      ])
      .jpeg({ chromaSubsampling: '4:4:4', mozjpeg: true, quality: 88 })
      .toBuffer(),
  );
}

export async function renderTemplateImage(input: TemplateImageInput): Promise<Uint8Array> {
  const palette = {
    blue: ['#0f2f75', '#2563eb', '#dbeafe'],
    gold: ['#452b05', '#d97706', '#fef3c7'],
    teal: ['#063b3b', '#0f766e', '#ccfbf1'],
  }[input.accent];
  const lines = titleLines(input.title);
  const title = lines
    .map(
      (line, index) =>
        `<text x="96" y="${300 + index * 82}" fill="#ffffff" font-size="58" font-weight="700" font-family="Noto Sans CJK SC, PingFang SC, Microsoft YaHei, sans-serif">${escapeXml(line)}</text>`,
    )
    .join('');
  const svg = Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="background" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="${palette[0]}"/>
          <stop offset="1" stop-color="${palette[1]}"/>
        </linearGradient>
      </defs>
      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#background)"/>
      <circle cx="1050" cy="130" r="250" fill="${palette[2]}" fill-opacity="0.18"/>
      <circle cx="1030" cy="690" r="360" fill="#ffffff" fill-opacity="0.07"/>
      <rect x="96" y="92" width="470" height="66" rx="22" fill="#ffffff" fill-opacity="0.14"/>
      <text x="126" y="137" fill="#ffffff" font-size="30" font-weight="600" font-family="Noto Sans CJK SC, PingFang SC, Microsoft YaHei, sans-serif">广州志远搬家服务有限公司</text>
      ${title}
      <text x="96" y="650" fill="#ffffff" fill-opacity="0.86" font-size="30" font-family="Noto Sans CJK SC, PingFang SC, Microsoft YaHei, sans-serif">${escapeXml(input.label)}</text>
      <rect x="930" y="690" width="210" height="64" rx="18" fill="#111827" fill-opacity="0.76"/>
      <text x="1035" y="733" text-anchor="middle" fill="#ffffff" font-size="27" font-family="Noto Sans CJK SC, PingFang SC, Microsoft YaHei, sans-serif">AI示意图</text>
    </svg>`);
  return Uint8Array.from(
    await sharp(svg).jpeg({ chromaSubsampling: '4:4:4', mozjpeg: true, quality: 90 }).toBuffer(),
  );
}

export async function imageMetadata(body: Uint8Array): Promise<ImageMetadata> {
  return validatedImageMetadata(body, {
    maxBytes: MAX_MEDIA_BYTES,
    maxEdge: MAX_MEDIA_EDGE,
    maxPixels: MAX_MEDIA_EDGE * MAX_MEDIA_EDGE,
  });
}

export async function sourceImageMetadata(body: Uint8Array): Promise<ImageMetadata> {
  return validatedImageMetadata(body, {
    maxBytes: MAX_SOURCE_IMAGE_BYTES,
    maxEdge: MAX_SOURCE_IMAGE_EDGE,
    maxPixels: MAX_SOURCE_IMAGE_PIXELS,
  });
}

export function inspectionPassed(result: ImageInspectionResult): boolean {
  return (
    result.decision === 'pass' &&
    result.articleRelevance >= 80 &&
    result.detectedText.length === 0 &&
    result.companyNames.length === 0 &&
    result.logosOrWatermarks.length === 0 &&
    result.phoneNumbers.length === 0 &&
    !result.unsafe &&
    !result.deceptiveRealism
  );
}

export function imageHash(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

async function validatedImageMetadata(
  body: Uint8Array,
  limits: Readonly<{ maxBytes: number; maxEdge: number; maxPixels: number }>,
): Promise<ImageMetadata> {
  if (body.byteLength > limits.maxBytes) {
    throw new Error(MEDIA_GATE_ERROR);
  }
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(body, {
      failOn: 'error',
      limitInputPixels: limits.maxPixels,
    }).metadata();
  } catch {
    throw new Error(MEDIA_GATE_ERROR);
  }
  if (
    (metadata.format !== 'jpeg' && metadata.format !== 'png' && metadata.format !== 'webp') ||
    !metadata.width ||
    !metadata.height ||
    Math.min(metadata.width, metadata.height) < 512 ||
    Math.max(metadata.width, metadata.height) < 768 ||
    metadata.width > limits.maxEdge ||
    metadata.height > limits.maxEdge ||
    metadata.width * metadata.height > limits.maxPixels
  ) {
    throw new Error(MEDIA_GATE_ERROR);
  }
  return Object.freeze({
    format: metadata.format,
    height: metadata.height,
    sizeBytes: body.byteLength,
    width: metadata.width,
  });
}

function titleLines(value: string): readonly string[] {
  const characters = [...value.trim()].slice(0, 42);
  const lines: string[] = [];
  for (let index = 0; index < characters.length; index += 14) {
    lines.push(characters.slice(index, index + 14).join(''));
  }
  return lines.slice(0, 3);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
