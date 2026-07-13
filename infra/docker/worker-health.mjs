import { createServer } from 'node:http';

const workerName = process.env.WORKER_NAME?.trim();
const healthPort = Number(process.env.HEALTH_PORT ?? '9090');

if (!workerName) {
  throw new Error('WORKER_NAME is required');
}

if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65_535) {
  throw new Error('HEALTH_PORT must be an integer between 1 and 65535');
}

let ready = true;

const server = createServer((request, response) => {
  const isLivenessRequest = request.url === '/health/live';
  const isReadinessRequest = request.url === '/health/ready';

  if (!isLivenessRequest && !isReadinessRequest) {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'not_found' }));
    return;
  }

  const available = isLivenessRequest || ready;
  response.writeHead(available ? 200 : 503, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  });
  response.end(
    JSON.stringify({
      capability: 'process-health',
      service: workerName,
      status: available ? 'ok' : 'not_ready',
    }),
  );
});

function beginShutdown() {
  ready = false;
  server.close((error) => {
    process.exit(error ? 1 : 0);
  });

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', beginShutdown);
process.once('SIGTERM', beginShutdown);
server.listen(healthPort, '0.0.0.0');
