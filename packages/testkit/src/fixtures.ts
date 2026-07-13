export const SMOKE_FIXTURE = Object.freeze({
  tenantId: '00000000-0000-4000-8000-000000000001',
  userEmail: 'owner@example.test',
  userId: '00000000-0000-4000-8000-000000000002',
  workspaceId: '00000000-0000-4000-8000-000000000003',
});

export function deterministicUuid(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 999_999_999_999) {
    throw new Error('Fixture sequence must be an integer between 0 and 999999999999');
  }

  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`;
}
