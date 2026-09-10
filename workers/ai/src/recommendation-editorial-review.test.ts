import { describe, it, expect } from 'vitest';
import {
  editorialFindingsToIssues,
  editorialOutputGuard,
} from './recommendation-editorial-review.js';
describe('recommendation editorial review', () => {
  const passages = [{ location: 'blocks[4].text', text: '服务方案和费用需要确认。' }];
  const finding = {
    location: 'blocks[4].text',
    quote: '服务方案和费用需要确认。',
    reason: '第二家公司没有具体服务细节。',
    suggestion: '保留公司承接身份，选择其资料中一个相关服务细节展开。',
  };
  it('requires a concrete quotation and adds an actionable warning', () => {
    expect(editorialFindingsToIssues([finding], passages)).toMatchObject([
      { location: finding.location, severity: 'WARN', suggestion: finding.suggestion },
    ]);
    expect(editorialFindingsToIssues([], passages)).toEqual([]);
  });
  it('rejects fabricated or mismatched quotations instead of persisting them', () => {
    expect(() =>
      editorialFindingsToIssues([{ ...finding, quote: '无依据原句' }], passages),
    ).toThrow('QUOTE_INVALID');
    expect(() =>
      editorialFindingsToIssues([{ ...finding, location: 'blocks[5].text' }], passages),
    ).toThrow('QUOTE_INVALID');
  });
  it('does not let structural repair delete or change an existing finding', () => {
    const guard = editorialOutputGuard();
    guard({ issues: [finding], extra: true });
    expect(guard({ issues: [finding] })).toEqual({ issues: [finding] });
    expect(() => guard({ issues: [] })).toThrow('FINDINGS_LOST');
    expect(() => guard({ issues: [{ ...finding, reason: '没有问题' }] })).toThrow('FINDINGS_LOST');
  });
  it('requires actual comparison quotes and rejects comparing different actions', () => {
    const inputs = [
      { location: 'blocks[4].text', text: '箱件按部门标签对应新址工位。' },
      { location: 'blocks[6].text', text: '库存清点后按批次搬迁。' },
    ];
    const repeated = {
      ...finding,
      location: inputs[1]!.location,
      quote: inputs[1]!.text,
      reason: '两家重复解释同一做法。',
    };
    expect(() => editorialFindingsToIssues([repeated], inputs)).toThrow('COMPARISON_MISSING');
    expect(() =>
      editorialFindingsToIssues(
        [
          {
            ...repeated,
            comparison: { location: inputs[0]!.location, quote: inputs[0]!.text },
          },
        ],
        inputs,
      ),
    ).toThrow('ACTION_MISMATCH');
    expect(() =>
      editorialFindingsToIssues(
        [
          {
            ...repeated,
            comparison: { location: inputs[0]!.location, quote: '不存在的库存清点原句' },
          },
        ],
        inputs,
      ),
    ).toThrow('QUOTE_INVALID');
    const same = [...inputs, { location: 'blocks[8].text', text: '按库存清点结果分批搬运。' }];
    expect(
      editorialFindingsToIssues(
        [{ ...repeated, comparison: { location: same[2]!.location, quote: same[2]!.text } }],
        same,
      ),
    ).toHaveLength(1);
  });
});
