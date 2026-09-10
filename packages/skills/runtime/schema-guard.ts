import type { JsonObject } from '@geo-content-os/adapter-model';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsImport, { type FormatsPlugin } from 'ajv-formats';

import { SkillRuntimeError, type SkillRuntimeErrorCode } from './skill-runtime.errors.js';

export interface SchemaCheck<T> {
  readonly diagnostics?: readonly string[];
  readonly paths: readonly string[];
  readonly valid: boolean;
  readonly value?: T;
}

export class SchemaGuard {
  private readonly ajv: Ajv2020;
  private readonly validators = new WeakMap<JsonObject, ValidateFunction>();

  public constructor() {
    this.ajv = new Ajv2020({ allErrors: true, strict: true });
    const addFormats = addFormatsImport as unknown as FormatsPlugin;
    addFormats(this.ajv);
  }

  public check<T>(schema: JsonObject, value: unknown): SchemaCheck<T> {
    const validator = this.validator(schema);
    if (validator(value))
      return Object.freeze({ paths: Object.freeze([]), valid: true, value: value as T });
    const diagnostics = (validator.errors ?? []).map((error) => {
      let actual: unknown = value;
      for (const part of error.instancePath.split('/').slice(1)) {
        actual =
          actual !== null && typeof actual === 'object'
            ? (actual as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')]
            : undefined;
      }
      const length = typeof actual === 'string' ? ` actual_length=${[...actual].length}` : '';
      const limit =
        typeof error.params['limit'] === 'number' ? ` limit=${error.params['limit']}` : '';
      return `${error.instancePath || '$'} ${error.keyword}${limit}${length}`;
    });
    return Object.freeze({
      paths: errorPaths(validator.errors),
      diagnostics: Object.freeze(diagnostics),
      valid: false,
    });
  }

  public assert<T>(
    schema: JsonObject,
    value: unknown,
    code: SkillRuntimeErrorCode,
    message: string,
  ): T {
    const result = this.check<T>(schema, value);
    if (!result.valid) throw new SkillRuntimeError(code, message, result.paths);
    return result.value as T;
  }

  private validator(schema: JsonObject): ValidateFunction {
    const cached = this.validators.get(schema);
    if (cached) return cached;
    const validator = this.ajv.compile(schema);
    this.validators.set(schema, validator);
    return validator;
  }
}

function errorPaths(errors: null | readonly ErrorObject[] | undefined): readonly string[] {
  const paths = new Set<string>();
  for (const error of errors ?? []) {
    let path = error.instancePath || '$';
    if (error.keyword === 'required' && typeof error.params['missingProperty'] === 'string') {
      path = `${path === '$' ? '' : path}/${error.params['missingProperty']}`;
    }
    if (
      error.keyword === 'additionalProperties' &&
      typeof error.params['additionalProperty'] === 'string'
    ) {
      path = `${path === '$' ? '' : path}/${error.params['additionalProperty']}`;
    }
    paths.add(path);
  }
  return Object.freeze([...paths].sort());
}
