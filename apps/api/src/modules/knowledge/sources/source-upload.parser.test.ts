import multipart from '@fastify/multipart';
import { renderTemplateImage } from '@geo-content-os/adapter-image';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseSourceUpload } from './source-upload.parser.js';

const MAX_BYTES = 25 * 1024 * 1024;
const fields = {
  workspace_id: '30000000-0000-4000-8000-000000000030',
  title: '企业证照测试',
  trust_level: 'verified',
  material_kind: 'certificate',
  certificate_name: '营业执照',
  certificate_number: 'TEST-001',
  holder_name: '示例企业有限公司',
  issuing_authority: '示例登记机关',
  verification_url: 'https://example.gov.cn/verify',
  article_use_allowed: 'true',
  public_display_confirmed: 'true',
};

describe('source upload JPEG validation', () => {
  const app = Fastify();
  let jpeg: Buffer;

  beforeAll(async () => {
    jpeg = Buffer.from(
      await renderTemplateImage({ accent: 'blue', label: '测试图片', title: '上传校验回归' }),
    );
    // Match the application defaults: the parser must override these for certificate fields.
    await app.register(multipart, { limits: { fields: 8, parts: 9, fileSize: MAX_BYTES } });
    app.post('/upload', async (request, reply) => {
      try {
        const parsed = await parseSourceUpload(request, MAX_BYTES);
        if (parsed.kind !== 'file') throw new Error('Expected file');
        return {
          contentHash: parsed.contentHash,
          mimeType: parsed.mimeType,
          size: parsed.body.length,
        };
      } catch (error) {
        return reply.code(422).send({ message: (error as Error).message });
      }
    });
    await app.ready();
  });

  afterAll(async () => app.close());

  async function upload(body: Buffer, filename = 'certificate.jpg', mime = 'image/jpeg') {
    const boundary = 'source-upload-test-boundary';
    const payload = Buffer.concat([
      ...Object.entries(fields).map(([name, value]) =>
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: 'POST',
      url: '/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
  }

  it.each([Buffer.alloc(0), Buffer.alloc(24, 0x7a), Buffer.from('\r\n')])(
    'accepts a decodable JPEG with trailing data and preserves the original bytes (%j)',
    async (tail) => {
      const body = Buffer.concat([jpeg, tail]);
      const result = await upload(body);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toEqual({
        contentHash: createHash('sha256').update(body).digest('hex'),
        mimeType: 'image/jpeg',
        size: body.length,
      });
    },
  );

  it.each([
    ['certificate.png', 'image/jpeg'],
    ['certificate.jpg', 'image/png'],
    ['certificate.jpg', 'application/octet-stream'],
  ])('rejects mismatched extension or MIME (%s, %s)', async (filename, mime) => {
    expect((await upload(jpeg, filename, mime)).statusCode).toBe(422);
  });

  it('rejects a JPEG with no end marker', async () => {
    expect((await upload(jpeg.subarray(0, -2))).statusCode).toBe(422);
  });

  it('rejects a forged JPEG signature', async () => {
    const body = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(512),
      Buffer.from([0xff, 0xd9]),
    ]);
    expect((await upload(body)).statusCode).toBe(422);
  });

  it('rejects truncated pixel data even when a JPEG end marker is appended', async () => {
    const body = Buffer.concat([
      jpeg.subarray(0, Math.floor(jpeg.length / 2)),
      Buffer.from([0xff, 0xd9]),
    ]);
    expect((await upload(body)).statusCode).toBe(422);
  });
});
