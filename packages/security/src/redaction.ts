const REDACTED = '[REDACTED]';
const SENSITIVE_KEY =
  /authorization|cookie|credential|password|secret|token|api[_-]?key|session|private[_-]?key/iu;

export function redactSensitiveData(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

export function redactSensitiveText(value: string): string {
  return value
    .replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/giu, `$1${REDACTED}@`)
    .replaceAll(/((?:set-cookie|cookie|authorization):\s*)[^\r\n]+/giu, `$1${REDACTED}`)
    .replaceAll(/Bearer\s+[^\s"']+/giu, `Bearer ${REDACTED}`)
    .replaceAll(
      /((?:access[_-]?token|api[_-]?key|credential|password|secret|session|token|x-amz-signature)=)[^&\s]+/giu,
      `$1${REDACTED}`,
    );
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value === null || value === undefined || ['number', 'boolean'].includes(typeof value)) {
    return value;
  }
  if (value instanceof Error) {
    return {
      message: redactSensitiveText(value.message),
      name: value.name,
      ...(value.stack ? { stack: redactSensitiveText(value.stack) } : {}),
    };
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item, seen),
    ]),
  );
}
