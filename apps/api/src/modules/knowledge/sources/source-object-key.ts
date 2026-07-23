export function buildUrlSnapshotObjectKey(
  tenantId: string,
  workspaceId: string,
  sourceId: string,
  contentHash: string,
): string {
  return `tenants/${tenantId}/workspaces/${workspaceId}/sources/${sourceId}/${contentHash}.url`;
}
