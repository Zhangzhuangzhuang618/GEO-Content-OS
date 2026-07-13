import type { EmailAdapter } from '@geo-content-os/adapter-email';
import { Inject, Injectable } from '@nestjs/common';

import { IDENTITY_EMAIL_ADAPTER } from '../email/email.module.js';
import {
  PasswordResetDelivery,
  type PasswordResetDeliveryMessage,
} from './password-reset.delivery.js';

@Injectable()
export class EmailPasswordResetDelivery extends PasswordResetDelivery {
  public constructor(@Inject(IDENTITY_EMAIL_ADAPTER) private readonly emailAdapter: EmailAdapter) {
    super();
  }

  public async deliver(message: PasswordResetDeliveryMessage): Promise<void> {
    await this.emailAdapter.sendPasswordReset(message);
  }
}
