export class TenantContextNotFoundError extends Error {
  public constructor() {
    super('Tenant is not available to the authenticated user');
    this.name = 'TenantContextNotFoundError';
  }
}
