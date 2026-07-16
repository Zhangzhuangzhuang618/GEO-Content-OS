import { createServer } from 'node:http';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';

const WORKSPACE_PATTERN = /^workspace-\d{3}$/;

export async function startFixtureServer() {
  const recoveryAttempts = new Map();
  const seenWorkspaces = new Set();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://fixture.local');
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { status: 'ready' });
        return;
      }

      const workspaceId = request.headers['x-load-workspace'];
      if (typeof workspaceId !== 'string' || !WORKSPACE_PATTERN.test(workspaceId)) {
        sendJson(response, 400, { code: 'WORKSPACE_REQUIRED' });
        return;
      }
      seenWorkspaces.add(workspaceId);

      if (request.method === 'GET' && url.pathname === '/load/api') {
        await delay(4);
        sendJson(response, 200, { workspace_id: workspaceId, status: 'ok' });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/load/rag') {
        const body = await readJson(request);
        if (body.workspace_id !== workspaceId || typeof body.query !== 'string') {
          sendJson(response, 400, { code: 'INVALID_RAG_REQUEST' });
          return;
        }
        await delay(12);
        sendJson(response, 200, {
          citations: [{ chunk_id: `chunk-${workspaceId}`, score: 0.9 }],
          workspace_id: workspaceId,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/load/queue') {
        const body = await readJson(request);
        if (body.workspace_id !== workspaceId || !request.headers['idempotency-key']) {
          sendJson(response, 400, { code: 'INVALID_QUEUE_REQUEST' });
          return;
        }
        await delay(6);
        sendJson(response, 202, { job_id: `job-${workspaceId}`, status: 'queued' });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/load/queue/recovery') {
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string') {
          sendJson(response, 400, { code: 'IDEMPOTENCY_KEY_REQUIRED' });
          return;
        }
        const attempts = (recoveryAttempts.get(key) ?? 0) + 1;
        recoveryAttempts.set(key, attempts);
        await delay(8);
        if (attempts === 1) {
          sendJson(response, 503, { code: 'QUEUE_TEMPORARILY_UNAVAILABLE' });
          return;
        }
        sendJson(response, 202, { recovered_after_attempts: attempts, status: 'queued' });
        return;
      }

      sendJson(response, 404, { code: 'RESOURCE_NOT_FOUND' });
    } catch (error) {
      sendJson(response, 500, {
        code: 'FIXTURE_ERROR',
        message: error instanceof Error ? error.message : 'unknown fixture error',
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture server did not expose a TCP port');
  }

  return Object.freeze({
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    port: address.port,
    seenWorkspaceCount: () => seenWorkspaces.size,
  });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error('fixture request body is too large');
    chunks.push(chunk);
  }
  const text = globalThis.Buffer.concat(chunks).toString('utf8');
  return text.length === 0 ? {} : JSON.parse(text);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
