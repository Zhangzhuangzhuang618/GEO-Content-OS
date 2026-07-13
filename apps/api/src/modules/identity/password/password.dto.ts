import { z } from 'zod';

export const NewPasswordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((value) => [...value].every((character) => isPrintableCharacter(character)), {
    message: 'Password must not contain control characters',
  });
const ResetTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u);

export const ForgotPasswordRequestSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.trim().toLowerCase()),
  })
  .strict();

export const ResetPasswordRequestSchema = z
  .object({
    new_password: NewPasswordSchema,
    token: ResetTokenSchema,
  })
  .strict();

export const ChangePasswordRequestSchema = z
  .object({
    current_password: z.string().min(1).max(256),
    new_password: NewPasswordSchema,
  })
  .strict()
  .refine((value) => value.current_password !== value.new_password, {
    message: 'New password must differ from the current password',
    path: ['new_password'],
  });

export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

function isPrintableCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
}
