import { describe, expect, it, vi } from 'vitest';

import type {
  ContentWriterPort,
  GeneratedContent,
  GenerationStorePort,
  ValidatedGenerationEvent,
  VariantGenerationRun,
} from './generation.types.js';
import { ContentGenerationWorker } from './generation.worker.js';

const CONTENT = Object.freeze({
  blocks: Object.freeze([
    Object.freeze({
      block_key: 'direct-answer',
      block_type: 'paragraph' as const,
      text: '正文',
    }),
  ]),
  citation_map: Object.freeze([]),
  cta: null,
  hashtags: Object.freeze([]),
  platform_code: 'master' as const,
  platform_meta: Object.freeze({}),
  schema_version: 'content-writer-data@1',
  summary: '摘要',
  title: '广州家庭搬家前如何核对服务范围与执行人员安排',
}) satisfies GeneratedContent;

const OFFICIAL_CONTENT = Object.freeze({
  ...CONTENT,
  platform_code: 'official_site' as const,
}) satisfies GeneratedContent;

describe('ContentGenerationWorker official-site direct flow', () => {
  it('uses staged writer methods only when the scheduler marks the brief', async () => {
    const store = new FakeStore();
    const genericMaster = vi.fn(async () => CONTENT);
    const genericVariant = vi.fn(async () => OFFICIAL_CONTENT);
    const directMaster = vi.fn(async () => CONTENT);
    const directVariant = vi.fn(async () => OFFICIAL_CONTENT);
    const writer: ContentWriterPort = {
      generateMaster: genericMaster,
      generateOfficialSiteMaster: directMaster,
      generateOfficialSiteVariant: directVariant,
      generateVariant: genericVariant,
    };

    const result = await new ContentGenerationWorker(store, writer, 1, 1_000).run(event());

    expect(result).toMatchObject({ failed: 0, packageStatus: 'generated', succeeded: 1 });
    expect(directMaster).toHaveBeenCalledOnce();
    expect(directVariant).toHaveBeenCalledOnce();
    expect(genericMaster).not.toHaveBeenCalled();
    expect(genericVariant).not.toHaveBeenCalled();
  });
});

class FakeStore implements GenerationStorePort {
  public async claim() {
    return { kind: 'claimed' as const, value: { leaseVersion: 1, masterAlreadySucceeded: false } };
  }

  public async claimVariant(_event: ValidatedGenerationEvent, run: VariantGenerationRun) {
    void _event;
    return {
      kind: 'claimed' as const,
      value: { leaseVersion: 1, run },
    };
  }

  public async failMaster(): Promise<void> {}

  public async failVariant(): Promise<void> {}

  public async finalize() {
    return 'generated' as const;
  }

  public async heartbeat(): Promise<void> {}

  public async loadMaster(): Promise<GeneratedContent> {
    return CONTENT;
  }

  public async saveMaster(): Promise<void> {}

  public async saveVariant(): Promise<void> {}
}

function event() {
  return {
    aggregate: { id: '60000000-0000-4000-8000-000000000053', type: 'content_package' },
    data: {
      actor_user_id: '10000000-0000-4000-8000-000000000053',
      input_hash: 'a'.repeat(64),
      master_run_id: '80000000-0000-4000-8000-000000000053',
      model_key: 'deepseek-v4-pro',
      model_policy: 'quality',
      package_id: '60000000-0000-4000-8000-000000000053',
      project_id: '40000000-0000-4000-8000-000000000053',
      prompt_version_id: '90000000-0000-4000-8000-000000000053',
      request_id: 'generation-request-53',
      skill_version: '1.0.0',
      variant_runs: [
        {
          platform_code: 'official_site',
          run_id: '81000000-0000-4000-8000-000000000053',
          variant_id: '71000000-0000-4000-8000-000000000053',
        },
      ],
      workspace_id: '30000000-0000-4000-8000-000000000053',
      writer_input: {
        brief: {
          constraints: { official_site_direct: true },
          platform_codes: ['official_site'],
        },
        generation_mode: 'draft',
      },
    },
    event_id: 'a0000000-0000-4000-8000-000000000053',
    event_type: 'content.package.generation_requested.v1',
    occurred_at: '2026-07-15T00:00:00.000Z',
    tenant: { id: '20000000-0000-4000-8000-000000000053' },
  };
}
