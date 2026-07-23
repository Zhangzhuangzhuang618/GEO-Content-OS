export { PlatformAccessModule } from './platform-access.module.js';
export {
  SupportAccessScopeSchema,
  SupportGrantRequestSchema,
  type SupportAccessScopeRequest,
  type SupportGrantRequest,
  type SupportGrantView,
} from './support-access.dto.js';
export {
  SupportAccessNotFoundError,
  SupportAccessValidationError,
} from './support-access.errors.js';
export {
  SupportAccessService,
  type AuthorizedSupportAccess,
  type SupportAccessAuditContext,
  type SupportAccessOperationInput,
} from './support-access.service.js';
