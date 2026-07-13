export interface PasswordResetDeliveryMessage {
  readonly email: string;
  readonly expiresAt: string;
  readonly resetTokenId: string;
  readonly token: string;
}

export abstract class PasswordResetDelivery {
  public abstract deliver(message: PasswordResetDeliveryMessage): Promise<void>;
}
