export interface MetricDefinition {
  readonly aggregation: 'average' | 'last' | 'sum';
  readonly allowNegative: boolean;
  readonly name: string;
  readonly unit: string;
}

/** Explicit registry: callers provide versioned product metrics instead of accepting arbitrary names. */
export class MetricRegistry {
  private readonly definitions = new Map<string, Readonly<MetricDefinition>>();

  public constructor(definitions: readonly MetricDefinition[]) {
    for (const definition of definitions) {
      if (
        !/^[a-z][a-z0-9_]{0,63}$/u.test(definition.name) ||
        !/^[a-z][a-z0-9_]{0,31}$/u.test(definition.unit) ||
        this.definitions.has(definition.name)
      ) {
        throw new TypeError('Metric registry definition is invalid');
      }
      this.definitions.set(definition.name, Object.freeze({ ...definition }));
    }
  }

  public get(name: string): Readonly<MetricDefinition> | undefined {
    return this.definitions.get(name);
  }

  public require(name: string): Readonly<MetricDefinition> {
    const definition = this.get(name);
    if (!definition) throw new RangeError('Metric is not registered');
    return definition;
  }

  public validateValue(name: string, value: number): void {
    const definition = this.require(name);
    if (!Number.isFinite(value) || (!definition.allowNegative && value < 0)) {
      throw new RangeError('Metric value is invalid');
    }
  }

  public list(): readonly Readonly<MetricDefinition>[] {
    return Object.freeze(
      [...this.definitions.values()].sort((left, right) => left.name.localeCompare(right.name)),
    );
  }
}
