import {
  createEmailAdapter,
  readEmailConfiguration,
  type EmailAdapter,
} from '@geo-content-os/adapter-email';
import { Module } from '@nestjs/common';

export const IDENTITY_EMAIL_ADAPTER = Symbol('IDENTITY_EMAIL_ADAPTER');

@Module({
  exports: [IDENTITY_EMAIL_ADAPTER],
  providers: [
    {
      provide: IDENTITY_EMAIL_ADAPTER,
      useFactory: (): EmailAdapter => createEmailAdapter(readEmailConfiguration()),
    },
  ],
})
export class IdentityEmailModule {}
