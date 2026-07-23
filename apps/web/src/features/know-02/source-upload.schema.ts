import { z } from 'zod';
export const UploadFormSchema = z
  .object({
    effective_from: z.string(),
    effective_to: z.string(),
    language: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u, '请输入有效语言标签。'),
    project_id: z.string(),
    title: z.string().trim().min(1, '请填写标题。').max(240),
    trust_level: z.enum(['verified', 'normal', 'untrusted']),
    url: z.string(),
    workspace_id: z.string().uuid('请选择工作区。'),
  })
  .superRefine((value, context) => {
    if (value.effective_from && value.effective_to && value.effective_to < value.effective_from)
      context.addIssue({
        code: 'custom',
        message: '结束日期不能早于开始日期。',
        path: ['effective_to'],
      });
  });
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
