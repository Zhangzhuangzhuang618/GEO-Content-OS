import { createConnection, createServer, type Server, type Socket } from 'node:net';

export interface TcpFaultProxyTarget {
  readonly host: string;
  readonly port: number;
}

export class TcpFaultProxy {
  private enabled = true;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();

  private constructor(private readonly target: TcpFaultProxyTarget) {
    assertPort(target.port);
    this.server = createServer((client) => this.forward(client));
  }

  public static async start(target: TcpFaultProxyTarget): Promise<TcpFaultProxy> {
    const proxy = new TcpFaultProxy(target);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once('error', reject);
      proxy.server.listen(0, '127.0.0.1', () => {
        proxy.server.off('error', reject);
        resolve();
      });
    });
    return proxy;
  }

  public get port(): number {
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('TCP fault proxy is not listening');
    }
    return address.port;
  }

  public get url(): string {
    return `redis://127.0.0.1:${this.port}/0`;
  }

  public disable(): void {
    this.enabled = false;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  public enable(): void {
    this.enabled = true;
  }

  public async close(): Promise<void> {
    this.disable();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private forward(client: Socket): void {
    if (!this.enabled) {
      client.destroy();
      return;
    }

    const upstream = createConnection(this.target);
    this.track(client);
    this.track(upstream);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }
}

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('target port must be an integer between 1 and 65535');
  }
}
