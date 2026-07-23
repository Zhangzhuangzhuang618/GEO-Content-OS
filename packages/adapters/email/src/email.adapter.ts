import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';

import type { EmailConfiguration } from './email.config.js';

export interface InvitationEmail {
  readonly email: string;
  readonly expiresAt: string;
  readonly inviterName: string;
  readonly tenantName: string;
  readonly token: string;
}

export interface PasswordResetEmail {
  readonly email: string;
  readonly expiresAt: string;
  readonly token: string;
}

export interface EmailDeliveryResult {
  readonly messageId: string;
  readonly transport: 'disabled' | 'smtp';
}

export interface EmailAdapter {
  sendInvitation(message: InvitationEmail): Promise<EmailDeliveryResult>;
  sendPasswordReset(message: PasswordResetEmail): Promise<EmailDeliveryResult>;
}

export interface MailTransport {
  sendMail(options: {
    readonly from: string;
    readonly html: string;
    readonly subject: string;
    readonly text: string;
    readonly to: string;
  }): Promise<{ readonly messageId?: string }>;
}

export function createEmailAdapter(configuration: EmailConfiguration): EmailAdapter {
  if (configuration.transport === 'disabled') return new DisabledEmailAdapter();
  if (!configuration.smtp) throw new Error('SMTP configuration is missing');
  const options: SMTPTransport.Options = {
    host: configuration.smtp.host,
    port: configuration.smtp.port,
    secure: configuration.smtp.secure,
    ...(configuration.smtp.user && configuration.smtp.password
      ? { auth: { pass: configuration.smtp.password, user: configuration.smtp.user } }
      : {}),
  };
  return new SmtpEmailAdapter(configuration, nodemailer.createTransport(options));
}

export class DisabledEmailAdapter implements EmailAdapter {
  public sendInvitation(message: InvitationEmail): Promise<EmailDeliveryResult> {
    void message;
    return Promise.resolve({ messageId: 'disabled', transport: 'disabled' });
  }

  public sendPasswordReset(message: PasswordResetEmail): Promise<EmailDeliveryResult> {
    void message;
    return Promise.resolve({ messageId: 'disabled', transport: 'disabled' });
  }
}

export class SmtpEmailAdapter implements EmailAdapter {
  public constructor(
    private readonly configuration: EmailConfiguration,
    private readonly transport: MailTransport,
  ) {}

  public async sendInvitation(message: InvitationEmail): Promise<EmailDeliveryResult> {
    const url = buildUrl(this.configuration.appBaseUrl, '/invitations/accept', message.token);
    return this.send({
      email: message.email,
      html: `<p>${escapeHtml(message.inviterName)} 邀请你加入 ${escapeHtml(message.tenantName)}。</p><p><a href="${escapeHtml(url)}">接受邀请</a></p><p>邀请有效期至 ${escapeHtml(message.expiresAt)}。</p>`,
      subject: `加入 ${message.tenantName} - GEO Content OS`,
      text: `${message.inviterName} 邀请你加入 ${message.tenantName}。\n接受邀请：${url}\n有效期至：${message.expiresAt}`,
    });
  }

  public async sendPasswordReset(message: PasswordResetEmail): Promise<EmailDeliveryResult> {
    const url = buildUrl(this.configuration.appBaseUrl, '/auth/password/reset', message.token);
    return this.send({
      email: message.email,
      html: `<p>你正在重置 GEO Content OS 密码。</p><p><a href="${escapeHtml(url)}">重置密码</a></p><p>链接有效期至 ${escapeHtml(message.expiresAt)}。</p>`,
      subject: '重置 GEO Content OS 密码',
      text: `重置密码：${url}\n有效期至：${message.expiresAt}`,
    });
  }

  private async send(input: {
    readonly email: string;
    readonly html: string;
    readonly subject: string;
    readonly text: string;
  }): Promise<EmailDeliveryResult> {
    let result: { readonly messageId?: string };
    try {
      result = await this.transport.sendMail({
        from: this.configuration.from,
        html: input.html,
        subject: input.subject.replaceAll(/[\r\n]/gu, ' '),
        text: input.text,
        to: input.email,
      });
    } catch {
      throw new Error('Email delivery failed');
    }
    return { messageId: result.messageId || 'smtp-accepted', transport: 'smtp' };
  }
}

function buildUrl(baseUrl: string, pathname: string, token: string): string {
  const url = new URL(pathname, baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
