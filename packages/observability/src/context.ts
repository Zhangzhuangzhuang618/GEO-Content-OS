import { context, propagation, trace, type Context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface TelemetryContextFields {
  readonly requestId?: string;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly jobId?: string;
  readonly runId?: string;
}

export interface TelemetryContext extends TelemetryContextFields {
  readonly traceId?: string;
  readonly spanId?: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{16,80}$/u;
const storage = new AsyncLocalStorage<TelemetryContextFields>();
let installedContextManager: AsyncLocalStorageContextManager | undefined;
let installedPropagator = false;
let installedTracerProvider: NodeTracerProvider | undefined;
let initialized = false;

export function initializeTelemetryContextManager(): void {
  if (initialized) return;
  initialized = true;

  const manager = new AsyncLocalStorageContextManager().enable();
  if (context.setGlobalContextManager(manager)) {
    installedContextManager = manager;
  } else {
    manager.disable();
  }
  const propagator = new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  });
  installedPropagator = propagation.setGlobalPropagator(propagator);

  const provider = new NodeTracerProvider();
  if (trace.setGlobalTracerProvider(provider)) {
    installedTracerProvider = provider;
  } else {
    void provider.shutdown();
  }
}

export function shutdownTelemetryContextManager(): void {
  if (installedContextManager) {
    installedContextManager.disable();
    installedContextManager = undefined;
    context.disable();
  }
  if (installedPropagator) propagation.disable();
  installedPropagator = false;
  if (installedTracerProvider) {
    void installedTracerProvider.shutdown();
    trace.disable();
    installedTracerProvider = undefined;
  }
  initialized = false;
}

export function resolveRequestId(value: string | readonly string[] | undefined): string {
  const candidate = typeof value === 'string' ? value.trim() : undefined;
  return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

export function runWithTelemetryContext<TResult>(
  fields: TelemetryContextFields,
  callback: () => TResult,
  parentContext: Context = context.active(),
): TResult {
  const merged = { ...storage.getStore(), ...compactFields(fields) };
  let baggage = propagation.getBaggage(parentContext) ?? propagation.createBaggage();
  for (const [key, value] of Object.entries({
    'geo.job_id': merged.jobId,
    'geo.request_id': merged.requestId,
    'geo.run_id': merged.runId,
    'geo.tenant_id': merged.tenantId,
  })) {
    if (value) baggage = baggage.setEntry(key, { value });
  }
  const propagatedContext = propagation.setBaggage(parentContext, baggage);

  return context.with(propagatedContext, () => storage.run(merged, callback));
}

export function enrichTelemetryContext(fields: TelemetryContextFields): void {
  const current = storage.getStore();
  if (!current) {
    throw new Error('Cannot enrich telemetry context outside an active request or job');
  }
  Object.assign(current, compactFields(fields));
}

export function getTelemetryContext(): TelemetryContext {
  const fields = storage.getStore() ?? {};
  const span = trace.getSpanContext(context.active());
  return {
    ...fields,
    ...(span?.traceId ? { traceId: span.traceId } : {}),
    ...(span?.spanId ? { spanId: span.spanId } : {}),
  };
}

function compactFields(fields: TelemetryContextFields): TelemetryContextFields {
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}
