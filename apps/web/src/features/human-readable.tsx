import type { ReactNode } from 'react';

const SKILL_LABELS: Readonly<Record<string, string>> = {
  'content-writer': '撰写内容',
  'fact-checker': '核对事实',
  'geo-optimizer': '优化搜索可见性',
  'material-parser': '整理资料',
  'quality-checker': '检查内容质量',
  'topic-planner': '规划选题',
};

const MODEL_LABELS: Readonly<Record<string, string>> = {
  'deepseek-flash': 'DeepSeek · 快速生成',
  'deepseek-pro': 'DeepSeek · 质量优先',
  'deepseek-v4-flash': 'DeepSeek · 快速生成',
  'mock-topic-planner': '本地演示',
};

export function skillLabel(value: string | null | undefined): string {
  if (!value) return '智能处理';
  return SKILL_LABELS[value] ?? '智能处理';
}

export function modelLabel(value: string | null | undefined): string {
  if (!value) return '系统自动选择';
  return MODEL_LABELS[value] ?? '系统自动选择';
}

export function TechnicalDetails({
  children,
  summary = '技术信息',
}: {
  readonly children: ReactNode;
  readonly summary?: string;
}) {
  return (
    <details className="text-xs text-ink-500">
      <summary className="cursor-pointer select-none font-medium text-ink-600">{summary}</summary>
      <div className="mt-2 space-y-1 break-all rounded-control bg-surface-subtle p-3 font-mono">
        {children}
      </div>
    </details>
  );
}
