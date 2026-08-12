const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function acceptInvitation(
  input: { readonly displayName: string; readonly password: string; readonly token: string },
  csrf: string,
): Promise<void> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/invitations/${encodeURIComponent(input.token)}/accept`,
    {
      body: JSON.stringify({ display_name: input.displayName.trim(), password: input.password }),
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      method: 'POST',
    },
  );
  if (!response.ok) throw new InvitationAcceptRequestError(response.status);
}

export class InvitationAcceptRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Invitation acceptance failed');
    this.name = 'InvitationAcceptRequestError';
  }
}
