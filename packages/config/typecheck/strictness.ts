const values: string[] = [];

// The assignment must fail when noUncheckedIndexedAccess is enabled.
// @ts-expect-error -- array access can be undefined
const firstValue: string = values[0];

type OptionalValue = {
  value?: string;
};

// The assignment must fail when exactOptionalPropertyTypes is enabled.
// @ts-expect-error -- omitted and explicitly undefined are intentionally distinct
const invalidOptional: OptionalValue = { value: undefined };

void firstValue;
void invalidOptional;
