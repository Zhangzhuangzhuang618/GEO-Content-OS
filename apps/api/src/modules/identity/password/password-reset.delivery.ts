import { Injectable } from '@nestjs/common';

export interface PasswordResetDeliveryMessage {
  readonly email: string;
  readonly expiresAt: string;
  readonly resetTokenId: string;
  readonly token: string;
}

export abstract class PasswordResetDelivery {
  public abstract deliver(message: PasswordResetDeliveryMessage): Promise<void>;
}

/** T016 replaces this safe sink with the email Adapter; credentials are never logged or persisted. */
@Injectable()
export class DeferredPasswordResetDelivery extends PasswordResetDelivery {
  public deliver(message: PasswordResetDeliveryMessage): Promise<void> {
    void message;
    return Promise.resolve();
  }
}
