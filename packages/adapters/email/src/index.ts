export {
  createEmailAdapter,
  DisabledEmailAdapter,
  SmtpEmailAdapter,
  type EmailAdapter,
  type EmailDeliveryResult,
  type InvitationEmail,
  type MailTransport,
  type PasswordResetEmail,
} from './email.adapter.js';
export {
  readEmailConfiguration,
  type EmailConfiguration,
  type EmailTransportKind,
} from './email.config.js';
