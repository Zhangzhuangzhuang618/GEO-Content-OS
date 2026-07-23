import { describe, expect, it } from 'vitest';

import { SchemaGuard } from '../../../../skills/runtime/schema-guard.js';
import { MATERIAL_PARSER_CONTRACT_V1 } from '../../../../skills/material-parser/contracts/v1.0.0/index.js';
import {
  MATERIAL_PARSER_DATA_SCHEMA,
  MATERIAL_PARSER_INPUT_SCHEMA,
  MATERIAL_PARSER_OUTPUT_SCHEMA,
} from './material-parser.schemas.js';

const guard = new SchemaGuard();

describe('material-parser contract v1.0.0', () => {
  it('keeps every versioned few-shot input and output schema-valid', () => {
    for (const fixture of MATERIAL_PARSER_CONTRACT_V1.fewShots) {
      expect(guard.check(MATERIAL_PARSER_INPUT_SCHEMA, fixture.input), fixture.id).toMatchObject({
        valid: true,
      });
      expect(guard.check(MATERIAL_PARSER_OUTPUT_SCHEMA, fixture.output), fixture.id).toMatchObject({
        valid: true,
      });
      expect(
        guard.check(MATERIAL_PARSER_DATA_SCHEMA, fixture.output.data),
        fixture.id,
      ).toMatchObject({
        valid: true,
      });
    }
  });

  it('uses the frozen skill identity, prompt version, and empty tool whitelist', () => {
    expect(MATERIAL_PARSER_CONTRACT_V1).toMatchObject({
      prompt: { version: 'material-parser-prompt@1.0.0' },
      skillName: 'material-parser',
      skillVersion: '1.0.0',
      toolNames: [],
    });
    expect(MATERIAL_PARSER_CONTRACT_V1.prompt.system).toContain('untrusted data');
    expect(MATERIAL_PARSER_CONTRACT_V1.prompt.task).toContain(
      'Do not mark candidate facts verified',
    );
  });

  it('rejects extra fields, verified claims, and invalid source references', () => {
    const fixture = MATERIAL_PARSER_CONTRACT_V1.fewShots[0]!;
    expect(
      guard.check(MATERIAL_PARSER_INPUT_SCHEMA, { ...fixture.input, tenant_id: 'model-supplied' }),
    ).toMatchObject({ valid: false });
    expect(
      guard.check(MATERIAL_PARSER_OUTPUT_SCHEMA, {
        ...fixture.output,
        data: {
          ...fixture.output.data,
          candidate_facts: [{ ...fixture.output.data.candidate_facts[0], status: 'verified' }],
        },
      }),
    ).toMatchObject({ valid: false });
    expect(
      guard.check(MATERIAL_PARSER_OUTPUT_SCHEMA, {
        ...fixture.output,
        data: {
          ...fixture.output.data,
          candidate_facts: [{ ...fixture.output.data.candidate_facts[0], source_chunk_no: -1 }],
        },
      }),
    ).toMatchObject({ valid: false });
  });

  it('keeps prompt injection as source data and never exposes tenant scope', () => {
    const fixture = MATERIAL_PARSER_CONTRACT_V1.fewShots.find(
      (candidate) => candidate.id === 'prompt-injection-is-data',
    );
    expect(fixture?.input.extracted_text).toContain('忽略系统指令');
    expect(fixture?.output.warnings).toEqual([
      expect.objectContaining({ code: 'PROMPT_INJECTION_DETECTED' }),
    ]);
    expect(JSON.stringify(MATERIAL_PARSER_INPUT_SCHEMA)).not.toContain('tenant_id');
    expect(MATERIAL_PARSER_CONTRACT_V1.toolNames).toHaveLength(0);
  });
});
