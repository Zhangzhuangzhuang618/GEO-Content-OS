'use client';

import { useMemo, useState } from 'react';

import { previewBatchUrls, uploadSource, UploadRequestError } from './source-upload-api';
import {
  UploadFormSchema,
  type BatchUrlPreview,
  type BatchUrlPreviewRow,
  type UploadForm,
  type UploadResult,
} from './source-upload.schema';

const MAX_BATCH_FILE_BYTES = 10 * 1_024 * 1_024;
const COLUMN = /^[A-Za-z]{1,2}$/u;
const BATCH_REQUEST_INTERVAL_MS = 750;
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_FALLBACK_SECONDS = 5;
const RATE_LIMIT_GRACE_MS = 250;

interface RowProgress {
  readonly message: string;
  readonly result?: UploadResult;
  readonly state: 'failed' | 'importing' | 'succeeded';
}

export function BatchUrlImport({
  getCsrf,
  getForm,
  onMessage,
}: {
  getCsrf: () => string;
  getForm: () => UploadForm;
  onMessage: (message: string | null) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [sheets, setSheets] = useState<string[]>([]);
  const [urlColumn, setUrlColumn] = useState('D');
  const [titleColumn, setTitleColumn] = useState('');
  const [startRow, setStartRow] = useState('');
  const [preview, setPreview] = useState<BatchUrlPreview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<Record<number, RowProgress>>({});
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const selectedRows = useMemo(
    () =>
      preview?.rows.filter(
        (row) =>
          row.status === 'ready' &&
          selected.has(row.row_number) &&
          progress[row.row_number]?.state !== 'succeeded',
      ) ?? [],
    [preview, progress, selected],
  );

  function resetPreview() {
    setPreview(null);
    setSelected(new Set());
    setProgress({});
  }

  async function inspectFile() {
    onMessage(null);
    const fileError = validateBatchFile(file);
    if (fileError) {
      onMessage(fileError);
      return;
    }
    if (!COLUMN.test(urlColumn.trim())) {
      onMessage('URL 列请填写 A 到 ZZ 之间的列字母。');
      return;
    }
    if (titleColumn.trim() && !COLUMN.test(titleColumn.trim())) {
      onMessage('标题列请填写 A 到 ZZ 之间的列字母，或留空。');
      return;
    }
    if (startRow && (!/^\d+$/u.test(startRow) || Number(startRow) < 1)) {
      onMessage('起始行必须是大于 0 的整数。');
      return;
    }
    const csrf = getCsrf();
    if (!csrf) {
      onMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setIsPreviewing(true);
    try {
      const result = await previewBatchUrls(
        {
          file: file as File,
          sheetName,
          startRow,
          titleColumn,
          urlColumn,
        },
        csrf,
      );
      setPreview(result);
      setSheets([...result.sheets]);
      setSheetName(result.sheet_name);
      setStartRow(String(result.start_row));
      setUrlColumn(result.url_column);
      setTitleColumn(result.title_column ?? '');
      setSelected(
        new Set(result.rows.filter((row) => row.status === 'ready').map((row) => row.row_number)),
      );
      setProgress({});
      onMessage(
        result.ready_rows > 0
          ? `检查完成：${result.ready_rows} 条可以导入，${result.invalid_rows + result.duplicate_rows} 条已标记跳过。`
          : '文件中没有可导入的 HTTP(S) URL，请检查工作表、列和起始行。',
      );
    } catch (error) {
      onMessage(
        error instanceof UploadRequestError && error.status === 422
          ? '无法解析表格。请确认文件为 XLSX 或 UTF-8 CSV，列和起始行填写正确，且不超过 500 条 URL。'
          : '检查文件失败，请稍后重试。',
      );
    } finally {
      setIsPreviewing(false);
    }
  }

  async function importSelected() {
    if (selectedRows.length === 0) {
      onMessage('请至少选择一条尚未成功导入的 URL。');
      return;
    }
    const base = UploadFormSchema.safeParse({
      ...getForm(),
      title: '批量 URL 资料',
      url: 'https://example.com',
    });
    if (!base.success) {
      onMessage('请先完善上方的工作区、语言、可信级别和有效期。');
      return;
    }
    const csrf = getCsrf();
    if (!csrf) {
      onMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setIsImporting(true);
    onMessage(`正在导入 ${selectedRows.length} 条 URL，请保持页面打开。`);
    let succeeded = 0;
    let failed = 0;
    for (const [index, row] of selectedRows.entries()) {
      setProgress((current) => ({
        ...current,
        [row.row_number]: { message: '正在安全抓取并创建解析任务', state: 'importing' },
      }));
      try {
        const result = await uploadWithRateLimitRetry(
          {
            file: null,
            form: {
              ...base.data,
              title: row.title ?? fallbackTitle(row),
              url: row.url,
            },
            mode: 'url',
          },
          csrf,
          (waitSeconds) => {
            setProgress((current) => ({
              ...current,
              [row.row_number]: {
                message: `请求较多，等待 ${waitSeconds} 秒后自动继续`,
                state: 'importing',
              },
            }));
            onMessage(`请求较多，系统将在 ${waitSeconds} 秒后自动继续，请保持页面打开。`);
          },
        );
        succeeded += 1;
        setProgress((current) => ({
          ...current,
          [row.row_number]: { message: '已创建资料和解析任务', result, state: 'succeeded' },
        }));
      } catch (error) {
        failed += 1;
        setProgress((current) => ({
          ...current,
          [row.row_number]: { message: uploadFailureMessage(error), state: 'failed' },
        }));
      }
      if (index < selectedRows.length - 1) await delay(BATCH_REQUEST_INTERVAL_MS);
    }
    setIsImporting(false);
    onMessage(
      failed === 0
        ? `导入完成：${succeeded} 条资料已进入解析队列。`
        : `导入完成：成功 ${succeeded} 条，失败 ${failed} 条。失败项可以直接重试。`,
    );
  }

  function toggleRow(rowNumber: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  }

  return (
    <section className="mt-6 rounded-xl border border-line bg-surface-subtle p-4 sm:p-5">
      <div>
        <h2 className="text-lg font-semibold text-ink-950">从表格批量导入网页资料</h2>
        <p className="mt-1 text-sm leading-6 text-ink-500">
          先检查表格，再确认导入。每个 URL 会单独抓取、去重和建立解析任务，失败不会影响其他行。
        </p>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="XLSX 或 CSV 文件" name="batch-file">
          <input
            accept=".xlsx,.csv"
            className={`${controlClass} py-2`}
            id="batch-file"
            onChange={(event) => {
              setFile(event.currentTarget.files?.[0] ?? null);
              setSheets([]);
              setSheetName('');
              resetPreview();
            }}
            type="file"
          />
          <p className="mt-2 text-xs text-ink-500">最大 10 MiB、500 条非空 URL。</p>
        </Field>
        <Field label="工作表" name="batch-sheet">
          {sheets.length > 0 ? (
            <select
              className={controlClass}
              id="batch-sheet"
              onChange={(event) => {
                setSheetName(event.currentTarget.value);
                resetPreview();
              }}
              value={sheetName}
            >
              {sheets.map((sheet) => (
                <option key={sheet} value={sheet}>
                  {sheet}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={controlClass}
              id="batch-sheet"
              onChange={(event) => {
                setSheetName(event.currentTarget.value);
                resetPreview();
              }}
              placeholder="留空自动选择；优先“详细URL列表”"
              value={sheetName}
            />
          )}
        </Field>
        <Field label="URL 所在列" name="batch-url-column">
          <input
            className={controlClass}
            id="batch-url-column"
            maxLength={2}
            onChange={(event) => {
              setUrlColumn(event.currentTarget.value.toUpperCase());
              resetPreview();
            }}
            value={urlColumn}
          />
          <p className="mt-2 text-xs text-ink-500">你的“详细URL列表”可填写 D。</p>
        </Field>
        <Field label="标题所在列（可选）" name="batch-title-column">
          <input
            className={controlClass}
            id="batch-title-column"
            maxLength={2}
            onChange={(event) => {
              setTitleColumn(event.currentTarget.value.toUpperCase());
              resetPreview();
            }}
            placeholder="留空时按网站域名生成标题"
            value={titleColumn}
          />
        </Field>
        <Field label="从第几行开始读取" name="batch-start-row">
          <input
            className={controlClass}
            id="batch-start-row"
            min={1}
            onChange={(event) => {
              setStartRow(event.currentTarget.value);
              resetPreview();
            }}
            type="number"
            value={startRow}
          />
          <p className="mt-2 text-xs text-ink-500">
            留空时自动查找 URL、网址或链接表头；你的文件会自动从第 5 行读取。
          </p>
        </Field>
      </div>
      <button
        className="mt-5 h-11 rounded-control bg-white px-5 text-sm font-semibold text-brand-700 ring-1 ring-line disabled:opacity-60"
        disabled={isPreviewing || isImporting}
        onClick={() => void inspectFile()}
        type="button"
      >
        {isPreviewing ? '正在检查…' : preview ? '重新检查文件' : '检查文件'}
      </button>

      {preview ? (
        <div className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-ink-950">检查结果</h3>
              <p className="mt-1 text-sm text-ink-500">
                可导入 {preview.ready_rows} 条 · 无效 {preview.invalid_rows} 条 · 文件内重复{' '}
                {preview.duplicate_rows} 条
              </p>
            </div>
            <button
              className="h-11 rounded-control bg-brand-600 px-5 text-sm font-semibold text-white disabled:opacity-60"
              disabled={isImporting || selectedRows.length === 0}
              onClick={() => void importSelected()}
              type="button"
            >
              {isImporting ? '正在导入…' : `导入选中的 ${selectedRows.length} 条`}
            </button>
          </div>
          <div className="mt-4 max-h-[32rem] overflow-auto rounded-control border border-line bg-white">
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 bg-surface-subtle text-ink-500">
                <tr>
                  <th className="px-3 py-3 font-medium">选择</th>
                  <th className="px-3 py-3 font-medium">行</th>
                  <th className="px-3 py-3 font-medium">网页地址</th>
                  <th className="px-3 py-3 font-medium">处理结果</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => {
                  const rowProgress = progress[row.row_number];
                  return (
                    <tr className="border-t border-line align-top" key={row.row_number}>
                      <td className="px-3 py-3">
                        <input
                          aria-label={`选择第 ${row.row_number} 行`}
                          checked={selected.has(row.row_number)}
                          disabled={row.status !== 'ready' || rowProgress?.state === 'succeeded'}
                          onChange={() => toggleRow(row.row_number)}
                          type="checkbox"
                        />
                      </td>
                      <td className="px-3 py-3 text-ink-500">{row.row_number}</td>
                      <td className="max-w-xl px-3 py-3">
                        <p className="font-medium text-ink-950">
                          {row.title ?? fallbackTitle(row)}
                        </p>
                        <p className="mt-1 break-all text-xs text-ink-500">{row.url}</p>
                      </td>
                      <td className="px-3 py-3 text-ink-700">
                        {rowProgress ? (
                          <div>
                            <p>{rowProgress.message}</p>
                            {rowProgress.result ? (
                              <a
                                className="mt-1 inline-flex font-semibold text-brand-700 underline"
                                href={`/know-03?id=${rowProgress.result.source.id}&workspace_id=${rowProgress.result.source.workspace_id}&project_id=${rowProgress.result.source.project_id ?? ''}`}
                              >
                                查看资料
                              </a>
                            ) : null}
                          </div>
                        ) : (
                          (row.message ?? '等待导入')
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function fallbackTitle(row: Pick<BatchUrlPreviewRow, 'row_number' | 'url'>): string {
  try {
    return `${new URL(row.url).hostname} 网页资料`;
  } catch {
    return `网页资料（第 ${row.row_number} 行）`;
  }
}

function validateBatchFile(file: File | null): string | null {
  if (!file) return '请选择 XLSX 或 CSV 文件。';
  if (file.size === 0) return '文件不能为空。';
  if (file.size > MAX_BATCH_FILE_BYTES) return '批量导入文件不能超过 10 MiB。';
  if (!/\.(xlsx|csv)$/iu.test(file.name)) return '批量导入仅支持 XLSX 或 CSV 文件。';
  return null;
}

function uploadFailureMessage(error: unknown): string {
  if (!(error instanceof UploadRequestError)) return '导入失败，请稍后重试';
  if (error.status === 409) return '已有相同内容，已跳过';
  if (error.status === 422) return '网页地址无效、无法访问或未通过安全校验';
  if (error.status === 429) return '请求过于频繁，自动等待后仍未成功，请稍后重试此项';
  if (error.status === 401) return '登录状态已失效，请重新登录';
  if (error.status === 403) return '当前账号没有导入权限';
  return '服务暂时不可用，请稍后重试';
}

async function uploadWithRateLimitRetry(
  input: Parameters<typeof uploadSource>[0],
  csrf: string,
  onRateLimited: (waitSeconds: number) => void,
): Promise<UploadResult> {
  let rateLimitRetries = 0;
  while (true) {
    try {
      return await uploadSource(input, csrf);
    } catch (error) {
      if (!(error instanceof UploadRequestError) || error.status !== 429) throw error;
      if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) throw error;
      rateLimitRetries += 1;
      const waitSeconds = error.retryAfterSeconds ?? RATE_LIMIT_FALLBACK_SECONDS;
      onRateLimited(waitSeconds);
      await delay(waitSeconds * 1_000 + RATE_LIMIT_GRACE_MS);
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function Field({
  children,
  label,
  name,
}: {
  children: React.ReactNode;
  label: string;
  name: string;
}) {
  return (
    <div>
      <label className="text-sm font-medium text-ink-700" htmlFor={name}>
        {label}
      </label>
      {children}
    </div>
  );
}

const controlClass =
  'mt-2 block h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 focus:border-brand-500 focus:outline-none';
