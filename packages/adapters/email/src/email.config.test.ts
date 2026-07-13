import { describe, expect, it } from 'vitest';

import { readEmailConfiguration } from './email.config.js';

describe('email configuration', () => {
  it('uses a disabled local transport without network side effects', () => {
    expect(readEmailConfiguration({})).toEqual({
      appBaseUrl: 'http://localhost:3000',
      from: 'GEO Content OS <no-reply@localhost>',
      transport: 'disabled',
    });
  });

  it('fails closed in production without SMTP and HTTPS links', () => {
    expect(() => readEmailConfiguration({ NODE_ENV: 'production' })).toThrow(
      'EMAIL_TRANSPORT=smtp',
    );
    expect(() =>
      readEmailConfiguration({
        EMAIL_TRANSPORT: 'smtp',
        NODE_ENV: 'production',
        PUBLIC_APP_URL: 'http://app.example.com',
        SMTP_HOST: 'smtp.example.com',
      }),
    ).toThrow('HTTPS');
  });

  it('requires complete SMTP credentials and parses a bounded port', () => {
    expect(() =>
      readEmailConfiguration({
        EMAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'user',
      }),
    ).toThrow('configured together');
    expect(() =>
      readEmailConfiguration({
        EMAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '70000',
      }),
    ).toThrow('SMTP_PORT');
  });
});
