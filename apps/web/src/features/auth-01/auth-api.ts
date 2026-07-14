export interface LoginInput {
  readonly csrf: string;
  readonly email: string;
  readonly password: string;
  readonly remember_me: boolean;
}

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function login(input: LoginInput): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/api/v1/auth/login`, {
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      remember_me: input.remember_me,
    }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': input.csrf,
    },
    method: 'POST',
  });

  if (!response.ok) throw new LoginFailedError(response.status);
}

export async function requestPasswordReset(email: string, csrf: string): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/api/v1/auth/password/forgot`, {
    body: JSON.stringify({ email }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });

  if (!response.ok) throw new PasswordResetRequestFailedError();
}

export class LoginFailedError extends Error {
  public constructor(public readonly status: number) {
    super('Login failed');
    this.name = 'LoginFailedError';
  }
}

export class PasswordResetRequestFailedError extends Error {
  public constructor() {
    super('Password reset request failed');
    this.name = 'PasswordResetRequestFailedError';
  }
}
