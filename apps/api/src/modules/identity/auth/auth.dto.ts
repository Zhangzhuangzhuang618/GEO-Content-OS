import { z } from 'zod';

export const LoginRequestSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.trim().toLowerCase()),
    password: z.string().min(1).max(256),
    remember_me: z.boolean().default(false),
  })
  .strict();

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export interface SessionView {
  readonly active_tenant_id: string | null;
  readonly expires_at: string;
  readonly user: {
    readonly display_name: string;
    readonly email: string;
    readonly id: string;
  };
}
