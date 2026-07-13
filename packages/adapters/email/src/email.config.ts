export type EmailTransportKind = 'disabled' | 'smtp';

export interface EmailConfiguration {
  readonly appBaseUrl: string;
  readonly from: string;
  readonly smtp?: {
    readonly host: string;
    readonly password?: string;
    readonly port: number;
    readonly secure: boolean;
    readonly user?: string;
  };
  readonly transport: EmailTransportKind;
}

export function readEmailConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): EmailConfiguration {
  const production = environment['NODE_ENV']?.trim() === 'production';
  const transport = readTransport(environment['EMAIL_TRANSPORT'], production);
  const appBaseUrl = readAppBaseUrl(environment['PUBLIC_APP_URL'], production);
  const from = environment['EMAIL_FROM']?.trim() || 'GEO Content OS <no-reply@localhost>';
  if (transport === 'disabled') return Object.freeze({ appBaseUrl, from, transport });

  const host = required(environment['SMTP_HOST'], 'SMTP_HOST');
  const port = readPort(environment['SMTP_PORT']);
  const secure = readBoolean(environment['SMTP_SECURE'], port === 465, 'SMTP_SECURE');
  const user = environment['SMTP_USER']?.trim();
  const password = environment['SMTP_PASSWORD'];
  if (Boolean(user) !== Boolean(password)) {
    throw new Error('SMTP_USER and SMTP_PASSWORD must be configured together');
  }

  return Object.freeze({
    appBaseUrl,
    from,
    smtp: Object.freeze({
      host,
      ...(password ? { password } : {}),
      port,
      secure,
      ...(user ? { user } : {}),
    }),
    transport,
  });
}

function readTransport(value: string | undefined, production: boolean): EmailTransportKind {
  const normalized = value?.trim();
  if (production && !normalized) {
    throw new Error('EMAIL_TRANSPORT=smtp is required in production');
  }
  const transport = normalized || 'disabled';
  if (transport !== 'disabled' && transport !== 'smtp') {
    throw new Error('EMAIL_TRANSPORT must be disabled or smtp');
  }
  if (production && transport !== 'smtp') {
    throw new Error('EMAIL_TRANSPORT=smtp is required in production');
  }
  return transport;
}

function readAppBaseUrl(value: string | undefined, production: boolean): string {
  const raw = value?.trim() || 'http://localhost:3000';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PUBLIC_APP_URL must be an absolute URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('PUBLIC_APP_URL must be an HTTP(S) origin without credentials, query, or hash');
  }
  if (production && url.protocol !== 'https:') {
    throw new Error('PUBLIC_APP_URL must use HTTPS in production');
  }
  return url.origin;
}

function readPort(value: string | undefined): number {
  const port = value?.trim() ? Number(value) : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SMTP_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function readBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}
