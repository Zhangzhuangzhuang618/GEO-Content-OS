import { CONTRACT_VERSION } from '@geo-content-os/contracts';
import {
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';

export type HealthStatus = 'ok' | 'not_ready';

export interface HealthCheck {
  readonly service: 'api';
  readonly status: HealthStatus;
  readonly timestamp: string;
  readonly version: string;
}

@Injectable()
export class HealthService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private ready = false;

  onApplicationBootstrap(): void {
    this.ready = true;
  }

  beforeApplicationShutdown(): void {
    this.beginShutdown();
  }

  beginShutdown(): void {
    this.ready = false;
  }

  liveness(): HealthCheck {
    return this.createCheck('ok');
  }

  readiness(): HealthCheck {
    return this.createCheck(this.ready ? 'ok' : 'not_ready');
  }

  private createCheck(status: HealthStatus): HealthCheck {
    return {
      service: 'api',
      status,
      timestamp: new Date().toISOString(),
      version: CONTRACT_VERSION,
    };
  }
}
