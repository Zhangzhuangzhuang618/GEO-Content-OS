import { hasExactOfficialSiteServicePhone } from '@geo-content-os/contracts';

// Account-scoped, operator-approved aliases only affect publication, never stored content.
export function resolvePublishServicePhone(
  content: unknown,
  currentPhone: string | null,
  accountId: string,
  compatibility: Readonly<Record<string, readonly string[]>>,
): string | null {
  const approved = compatibility[accountId] ?? [];
  if (!currentPhone || !approved.includes(currentPhone)) return currentPhone;
  return approved.find((phone) => hasExactOfficialSiteServicePhone(content, phone)) ?? currentPhone;
}
