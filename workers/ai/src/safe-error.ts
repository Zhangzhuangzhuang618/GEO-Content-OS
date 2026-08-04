export function safeError(value: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = value;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    if (seen.has(current)) {
      parts.push('circular cause');
      break;
    }
    seen.add(current);
    parts.push(errorPart(current));
    current = record(current) ? current['cause'] : undefined;
  }
  return parts.length > 0 ? parts.join(' <- caused by: ').slice(0, 2_000) : 'Unknown media error';
}

function errorPart(value: unknown): string {
  if (!record(value)) return redactSensitiveText(String(value));
  const name = typeof value['name'] === 'string' ? value['name'] : 'Error';
  const message =
    typeof value['message'] === 'string' ? redactSensitiveText(value['message']) : 'Unknown error';
  const metadata = record(value['$metadata']) ? value['$metadata'] : null;
  const details = [
    errorDetail('code', value['code']),
    errorDetail('errno', value['errno']),
    errorDetail('syscall', value['syscall']),
    errorDetail('hostname', value['hostname']),
    errorDetail('address', value['address']),
    errorDetail('port', value['port']),
    errorDetail('http_status', metadata?.['httpStatusCode']),
    errorDetail('request_id', metadata?.['requestId']),
    errorDetail('extended_request_id', metadata?.['extendedRequestId']),
  ].filter((detail): detail is string => detail !== null);
  return `${name}: ${message}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

function errorDetail(label: string, value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return `${label}=${redactSensitiveText(String(value)).slice(0, 200)}`;
}

function redactSensitiveText(value: string): string {
  return value
    .replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/giu, '$1[REDACTED]@')
    .replaceAll(/((?:set-cookie|cookie|authorization):\s*)[^\r\n]+/giu, '$1[REDACTED]')
    .replaceAll(/Bearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replaceAll(
      /((?:access[_-]?token|api[_-]?key|credential|password|secret|session|token|x-amz-signature)\s*[:=]\s*)[^&\s,;)]+/giu,
      '$1[REDACTED]',
    );
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
