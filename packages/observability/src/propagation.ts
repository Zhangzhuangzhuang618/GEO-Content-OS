import { context, ROOT_CONTEXT, type Context, type TextMapGetter } from '@opentelemetry/api';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';

import { runWithTelemetryContext, type TelemetryContextFields } from './context.js';

export type TraceCarrier = Readonly<Record<string, string | readonly string[] | undefined>>;

const propagator = new CompositePropagator({
  propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
});

const getter: TextMapGetter<TraceCarrier> = {
  get(carrier, key) {
    const value = carrier[key] ?? carrier[key.toLowerCase()];
    return typeof value === 'string' || value === undefined ? value : Array.from(value);
  },
  keys(carrier) {
    return Object.keys(carrier);
  },
};

export function extractTraceContext(
  carrier: TraceCarrier,
  parentContext: Context = ROOT_CONTEXT,
): Context {
  return propagator.extract(parentContext, carrier, getter);
}

export function injectTraceContext(
  activeContext: Context = context.active(),
): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagator.inject(activeContext, carrier, {
    set(target, key, value) {
      target[key] = value;
    },
  });
  return carrier;
}

export function runWithExtractedTraceContext<TResult>(
  carrier: TraceCarrier,
  fields: TelemetryContextFields,
  callback: () => TResult,
): TResult {
  return runWithTelemetryContext(fields, callback, extractTraceContext(carrier));
}
