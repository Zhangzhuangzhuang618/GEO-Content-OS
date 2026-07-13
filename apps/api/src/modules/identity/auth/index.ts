export { readAuthConfiguration, type AuthConfiguration } from './auth.config.js';
export { AuthModule } from './auth.module.js';
export {
  AuthService,
  type AuthenticatedSession,
  type AuthSessionPrincipal,
  type LoginResult,
} from './auth.service.js';
export { LoginRequestSchema, type LoginRequest, type SessionView } from './auth.dto.js';
export { PasswordHasher, ARGON2ID_OPTIONS } from './password-hasher.js';
