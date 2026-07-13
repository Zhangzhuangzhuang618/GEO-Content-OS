import { describe, expect, it } from 'vitest';

import { DisabledEmailAdapter, SmtpEmailAdapter, type MailTransport } from './email.adapter.js';
import type { EmailConfiguration } from './email.config.js';

const configuration: EmailConfiguration = {
  appBaseUrl: 'https://app.example.com',
  from: 'GEO Content OS <no-reply@example.com>',
  smtp: { host: 'smtp.example.com', port: 587, secure: false },
  transport: 'smtp',
};

describe('email Adapter', () => {
  it('keeps local delivery disabled and side-effect free', async () => {
    const adapter = new DisabledEmailAdapter();
    await expect(
      adapter.sendPasswordReset({
        email: 'user@example.com',
        expiresAt: '2026-07-14T12:00:00.000Z',
        token: 'a'.repeat(43),
      }),
    ).resolves.toEqual({ messageId: 'disabled', transport: 'disabled' });
  });

  it('renders escaped invitation and password-reset templates with encoded links', async () => {
    const transport = new CapturingTransport();
    const adapter = new SmtpEmailAdapter(configuration, transport);
    const invitationToken = 'a'.repeat(43);
    const resetToken = 'b'.repeat(43);

    await adapter.sendInvitation({
      email: 'invitee@example.com',
      expiresAt: '2026-07-17T12:00:00.000Z',
      inviterName: '<Owner>',
      tenantName: 'Acme & Co\r\nBcc: attacker@example.com',
      token: invitationToken,
    });
    await adapter.sendPasswordReset({
      email: 'invitee@example.com',
      expiresAt: '2026-07-14T12:00:00.000Z',
      token: resetToken,
    });

    expect(transport.messages).toHaveLength(2);
    expect(transport.messages[0]?.html).toContain('&lt;Owner&gt;');
    expect(transport.messages[0]?.html).toContain('Acme &amp; Co');
    expect(transport.messages[0]?.subject).not.toContain('\n');
    expect(transport.messages[0]?.text).toContain(
      `https://app.example.com/invitations/accept?token=${invitationToken}`,
    );
    expect(transport.messages[1]?.text).toContain(
      `https://app.example.com/auth/password/reset?token=${resetToken}`,
    );
  });

  it('rethrows a credential-safe delivery error without token or provider details', async () => {
    const secretToken = 'c'.repeat(43);
    const transport: MailTransport = {
      sendMail: () => Promise.reject(new Error(`provider leaked ${secretToken}`)),
    };
    const adapter = new SmtpEmailAdapter(configuration, transport);

    let failure: unknown;
    try {
      await adapter.sendPasswordReset({
        email: 'user@example.com',
        expiresAt: '2026-07-14T12:00:00.000Z',
        token: secretToken,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(new Error('Email delivery failed'));
    expect(String(failure)).not.toContain(secretToken);
  });
});

class CapturingTransport implements MailTransport {
  public readonly messages: Array<{
    readonly from: string;
    readonly html: string;
    readonly subject: string;
    readonly text: string;
    readonly to: string;
  }> = [];

  public sendMail(
    message: (typeof this.messages)[number],
  ): Promise<{ readonly messageId: string }> {
    this.messages.push(message);
    return Promise.resolve({ messageId: `message-${this.messages.length}` });
  }
}
