import { createApplication } from './application.js';

const DEFAULT_API_HOST = '0.0.0.0';
const DEFAULT_API_PORT = 3_000;

export interface ApiRuntimeConfiguration {
  readonly host: string;
  readonly port: number;
}

export function readApiRuntimeConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): ApiRuntimeConfiguration {
  const host = environment.API_HOST?.trim() || DEFAULT_API_HOST;
  const rawPort = environment.PORT?.trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_API_PORT;

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return { host, port };
}

export async function bootstrap(): Promise<void> {
  const configuration = readApiRuntimeConfiguration();
  const application = await createApplication();

  await application.listen({
    host: configuration.host,
    port: configuration.port,
  });
}
