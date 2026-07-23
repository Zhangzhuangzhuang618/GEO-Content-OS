import { TextDecoder } from 'node:util';

import { MaterialParserError } from './parser.errors.js';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const MAX_ZIP_COMMENT_BYTES = 65_535;
const MAX_ENTRIES = 10_000;
const MAX_COMPRESSION_RATIO = 200;

export function validateDocxArchive(body: Uint8Array, maxExpandedBytes: number): void {
  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes);
  if (endOffset < 0 || endOffset + 22 > bytes.byteLength) fail('DOCX central directory is missing');
  const disk = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0 ||
    entryCount > MAX_ENTRIES ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    fail('DOCX uses an unsupported split, empty, oversized, or ZIP64 archive');
  }
  if (centralOffset + centralSize > endOffset) fail('DOCX central directory bounds are invalid');

  let offset = centralOffset;
  let expandedBytes = 0;
  const names = new Set<string>();
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || bytes.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
      fail('DOCX central directory entry is malformed');
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const expandedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > endOffset) fail('DOCX central directory entry exceeds archive bounds');
    if ((flags & 0x1) !== 0 || ![0, 8].includes(method)) {
      fail('Encrypted or unsupported DOCX entries are not allowed');
    }
    if (compressedSize === 0xffffffff || expandedSize === 0xffffffff) {
      fail('ZIP64 DOCX entries are not supported');
    }
    if (
      expandedSize > maxExpandedBytes ||
      (expandedSize > 0 && compressedSize === 0) ||
      (compressedSize > 0 && expandedSize / compressedSize > MAX_COMPRESSION_RATIO)
    ) {
      fail('DOCX entry exceeds expansion or compression-ratio limits');
    }
    expandedBytes += expandedSize;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > maxExpandedBytes) {
      fail('DOCX archive exceeds the total expansion limit');
    }
    const filename = decodeFilename(bytes.subarray(offset + 46, offset + 46 + nameLength), flags);
    if (
      !filename ||
      filename.startsWith('/') ||
      filename.includes('\\') ||
      filename.split('/').includes('..')
    ) {
      fail('DOCX archive contains an unsafe entry path');
    }
    names.add(filename);
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize)
    fail('DOCX central directory size does not match entries');
  if (!names.has('[Content_Types].xml') || !names.has('word/document.xml')) {
    fail('DOCX archive is missing required OOXML parts');
  }
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.byteLength - (22 + MAX_ZIP_COMMENT_BYTES));
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }
  return -1;
}

function decodeFilename(value: Uint8Array, flags: number): string {
  try {
    return new TextDecoder((flags & 0x800) !== 0 ? 'utf-8' : 'latin1', { fatal: true }).decode(
      value,
    );
  } catch {
    fail('DOCX entry name encoding is invalid');
  }
}

function fail(message: string): never {
  throw new MaterialParserError('PARSE_EMPTY', message);
}
