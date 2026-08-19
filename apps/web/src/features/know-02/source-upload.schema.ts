import { z } from 'zod';
export const UploadFormSchema = z
  .object({
    article_use_allowed: z.boolean(),
    certificate_name: z.string(),
    certificate_number: z.string(),
    effective_from: z.string(),
    effective_to: z.string(),
    holder_name: z.string(),
    insurance_type: z.string(),
    insured_count: z.string(),
    insurer_name: z.string(),
    issuing_authority: z.string(),
    language: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u, '请输入有效语言标签。'),
    material_kind: z.enum(['document', 'certificate', 'insurance_proof']),
    policyholder_name: z.string(),
    project_id: z.string(),
    public_display_confirmed: z.boolean(),
    summary_use_confirmed: z.boolean(),
    title: z.string().trim().min(1, '请填写标题。').max(240),
    trust_level: z.enum(['verified', 'normal', 'untrusted']),
    url: z.string(),
    verification_url: z.string(),
    workspace_id: z.string().uuid('请选择工作区。'),
  })
  .superRefine((value, context) => {
    if (value.effective_from && value.effective_to && value.effective_to < value.effective_from)
      context.addIssue({
        code: 'custom',
        message: '结束日期不能早于开始日期。',
        path: ['effective_to'],
      });
    if (value.material_kind === 'certificate') {
      for (const [field, message, maximum] of [
        ['certificate_name', '请填写证照名称。', 240],
        ['certificate_number', '请填写证照编号。', 120],
        ['holder_name', '请填写持证主体。', 240],
        ['issuing_authority', '请填写发证机关。', 240],
      ] as const) {
        const current = value[field].trim();
        if (!current || current.length > maximum)
          context.addIssue({ code: 'custom', message, path: [field] });
      }
      if (value.verification_url) {
        try {
          const verificationUrl = new URL(value.verification_url);
          if (verificationUrl.protocol !== 'https:') throw new Error();
        } catch {
          context.addIssue({
            code: 'custom',
            message: '核验链接必须是有效的 HTTPS 地址。',
            path: ['verification_url'],
          });
        }
      }
      if (value.article_use_allowed && !value.public_display_confirmed)
        context.addIssue({
          code: 'custom',
          message: '允许文章展示前必须完成公开内容确认。',
          path: ['public_display_confirmed'],
        });
      if (value.article_use_allowed && value.trust_level === 'untrusted')
        context.addIssue({
          code: 'custom',
          message: '不可信资料不能授权随文章展示。',
          path: ['trust_level'],
        });
    }
    if (value.material_kind === 'insurance_proof') {
      for (const [field, message, maximum] of [
        ['insurer_name', '请填写承保机构。', 240],
        ['policyholder_name', '请填写投保主体。', 240],
        ['insurance_type', '请填写保险类型。', 240],
      ] as const) {
        const current = value[field].trim();
        if (!current || current.length > maximum)
          context.addIssue({ code: 'custom', message, path: [field] });
        else if (containsSensitiveIdentifier(current))
          context.addIssue({
            code: 'custom',
            message: '脱敏摘要字段不能包含手机号、证件号、银行卡号或邮箱。',
            path: [field],
          });
      }
      if (!/^[1-9][0-9]*$/u.test(value.insured_count.trim()))
        context.addIssue({
          code: 'custom',
          message: '参保人数必须是 1 至 100000 的整数。',
          path: ['insured_count'],
        });
      else if (Number(value.insured_count) > 100_000)
        context.addIssue({
          code: 'custom',
          message: '参保人数必须是 1 至 100000 的整数。',
          path: ['insured_count'],
        });
      if (!value.effective_from || !value.effective_to)
        context.addIssue({
          code: 'custom',
          message: '保险证明必须填写完整保障期间。',
          path: ['effective_from'],
        });
      if (value.trust_level !== 'verified')
        context.addIssue({
          code: 'custom',
          message: '保险证明必须选择“已验证”。',
          path: ['trust_level'],
        });
      if (!value.summary_use_confirmed)
        context.addIssue({
          code: 'custom',
          message: '请确认仅允许脱敏摘要参与检索和生文。',
          path: ['summary_use_confirmed'],
        });
    }
  });

function containsSensitiveIdentifier(value: string): boolean {
  return (
    /(^|\D)1[3-9][0-9]{9}(\D|$)/u.test(value) ||
    /(^|[^0-9A-Za-z])[0-9]{17}[0-9Xx]([^0-9A-Za-z]|$)/u.test(value) ||
    /(^|\D)[0-9]{16,19}(\D|$)/u.test(value) ||
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u.test(value)
  );
}
export const ProjectPageSchema = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string().min(1),
          status: z.enum(['active', 'archived']),
        })
        .passthrough(),
    ),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .passthrough();
export const UploadResponseSchema = z
  .object({
    data: z
      .object({
        source: z
          .object({
            id: z.string().uuid(),
            project_id: z.string().uuid().nullable(),
            title: z.string().min(1),
            status: z.enum(['processing', 'active', 'expired', 'failed']),
            workspace_id: z.string().uuid(),
          })
          .passthrough(),
        ingest_job: z
          .object({
            id: z.string().uuid(),
            status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
          })
          .passthrough(),
      })
      .strict(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();
export const BatchUrlPreviewResponseSchema = z
  .object({
    data: z
      .object({
        duplicate_rows: z.number().int().nonnegative(),
        file_name: z.string().min(1),
        invalid_rows: z.number().int().nonnegative(),
        ready_rows: z.number().int().nonnegative(),
        rows: z.array(
          z
            .object({
              message: z.string().nullable(),
              row_number: z.number().int().positive(),
              status: z.enum(['ready', 'invalid', 'duplicate']),
              title: z.string().nullable(),
              url: z.string().min(1),
            })
            .strict(),
        ),
        sheet_name: z.string().min(1),
        sheets: z.array(z.string().min(1)).min(1),
        start_row: z.number().int().positive(),
        title_column: z.string().nullable(),
        total_rows: z.number().int().nonnegative(),
        url_column: z.string().min(1),
      })
      .strict(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();
export type UploadForm = z.infer<typeof UploadFormSchema>;
export type ProjectChoice = z.infer<typeof ProjectPageSchema>['data'][number];
export type UploadResult = z.infer<typeof UploadResponseSchema>['data'];
export type BatchUrlPreview = z.infer<typeof BatchUrlPreviewResponseSchema>['data'];
export type BatchUrlPreviewRow = BatchUrlPreview['rows'][number];
