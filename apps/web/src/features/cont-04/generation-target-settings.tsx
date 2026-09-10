'use client';
import { useEffect, useState } from 'react';
import { listPlatformAccounts } from '../pub-01/platform-account-api';
import type { PlatformAccount } from '../pub-01/platform-account.schema';
import { ContentStyleSelect, type ContentStyle } from '../pub-01/account-content-policy';

export type GenerationTargets = Partial<
  Record<'official_site' | 'lieju' | 'douyin', { account_id: string; content_style?: ContentStyle }>
>;
export function GenerationTargetSettings({
  workspaceId,
  platforms,
  value,
  onChange,
}: {
  workspaceId: string;
  platforms: readonly string[];
  value: GenerationTargets;
  onChange: (value: GenerationTargets) => void;
}) {
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void listPlatformAccounts({ workspaceId, status: 'active' }, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setAccounts(items);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setMessage('无法读取发布账号，请检查当前账号的工作区权限。');
      });
    return () => controller.abort();
  }, [workspaceId]);
  return (
    <div className="mt-4 grid gap-3" aria-label="本次生成配置">
      {(['official_site', 'lieju', 'douyin'] as const)
        .filter((platform) => platforms.includes(platform))
        .map((platform) => {
          const candidates = accounts.filter((account) => account.platform_code === platform);
          const selected = value[platform];
          const name = { official_site: '官网', lieju: '列举网', douyin: '抖音' }[platform];
          return (
            <div
              key={platform}
              className="grid gap-2 rounded-lg border border-line p-3 md:grid-cols-2"
            >
              <label className="grid gap-2 text-sm">
                {name}目标账号
                <select
                  className="rounded-lg border border-line p-2"
                  value={selected?.account_id ?? ''}
                  onChange={(event) => {
                    const next = { ...value };
                    if (event.target.value) next[platform] = { account_id: event.target.value };
                    else delete next[platform];
                    onChange(next);
                  }}
                >
                  <option value="">
                    {candidates.length === 1
                      ? `自动选择：${candidates[0]!.display_name}`
                      : '请选择账号'}
                  </option>
                  {candidates.map((account) => (
                    <option value={account.id} key={account.id}>
                      {account.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <ContentStyleSelect
                label={`${name}本次生文风格`}
                value={selected?.content_style ?? ''}
                onChange={(style) => {
                  const accountId =
                    selected?.account_id ?? (candidates.length === 1 ? candidates[0]!.id : null);
                  if (!accountId) return setMessage('请先选择目标账号');
                  onChange({
                    ...value,
                    [platform]: {
                      account_id: accountId,
                      ...(style ? { content_style: style } : {}),
                    },
                  });
                  setMessage('');
                }}
              />
            </div>
          );
        })}
      <p className="text-xs text-ink-600">
        本次选择不修改账号默认设置。推荐名单与资料在“发布账号 → 内容设置”中配置。
      </p>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
