import { KernelError } from './fd-table.ts';

export const SEALED_OAUTH_TIMEOUT_MS = 45_000;
export const SEALED_OAUTH_OPS: ReadonlySet<string> = new Set([
  'oauthGrant',
  'oauthStatus',
  'oauthRefresh',
  'oauthRemove',
]);

export interface SealedOAuthIdentity {
  name: string;
  provider: string;
  account: string;
}

export interface SealedOAuthConfig {
  tokenUrl: string;
  clientId: string;
  authMethod: 'none';
  scope?: string;
  resource?: string;
}

export type SealedOAuthRequest = { v: 1 } & (
  | { op: 'capabilities' }
  | (SealedOAuthIdentity & {
      op: 'oauthGrant';
      accessToken: string;
      refreshToken?: string;
      tokenType?: string;
      expiresAt?: number;
      oauth: SealedOAuthConfig;
    })
  | (SealedOAuthIdentity & { op: 'oauthStatus' | 'oauthRefresh' | 'oauthRemove' })
);

export type SealedOAuthState =
  | 'ready'
  | 'refreshing'
  | 'expired'
  | 'reauth-required'
  | 'removed'
  | 'locked';

export interface SealedOAuthStatus {
  v: 1;
  placeholder: string;
  state: SealedOAuthState;
  expiresAt: number | null;
  refreshable: boolean;
}

const MESSAGES = {
  EINVAL: 'Invalid OAuth request',
  ENOENT: 'OAuth credential not found',
  EEXIST: 'OAuth credential identity conflicts',
  EACCES: 'OAuth operation refused',
  EAGAIN: 'OAuth credential changed; try again',
  ENOTSUP: 'OAuth operation is not supported',
  ENOTCONN: 'Vault is unavailable',
  ETIMEDOUT: 'Vault request timed out',
  EIO: 'Invalid vault reply',
} as const;

const CAUSES = {
  'vault-locked': 'Vault is locked',
  'oauth-reauth-required': 'OAuth sign-in is required',
  'oauth-refresh-failed': 'OAuth refresh failed',
} as const;

export interface SealedOAuthError {
  v: 1;
  error: {
    code: keyof typeof MESSAGES;
    cause?: keyof typeof CAUSES;
    message: string;
  };
}

export type SealedOAuthReply =
  | SealedOAuthStatus
  | { v: 1; removed: true }
  | { v: 1; capabilities: { kernelOAuth?: 1 } }
  | SealedOAuthError;

const COMMON = ['v', 'op', 'caller'];
const IDENTITY = [...COMMON, 'name', 'provider', 'account'];
const GRANT = [...IDENTITY, 'accessToken', 'refreshToken', 'tokenType', 'expiresAt', 'oauth'];
const CONFIG = ['tokenUrl', 'clientId', 'authMethod', 'scope', 'resource'];
const UNSUPPORTED = ['auth', 'clientSecret', 'fields'];
const STATES: ReadonlySet<string> = new Set([
  'ready',
  'refreshing',
  'expired',
  'reauth-required',
  'removed',
  'locked',
]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,127}$/;
const PLACEHOLDER = /^fnox_proxy_[0-9a-f]{24}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && keys(value, fields);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function epoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function sealedOAuthOperation(op: string): boolean {
  return op === 'capabilities' || SEALED_OAUTH_OPS.has(op);
}

export function validateSealedOAuth(req: Record<string, unknown>): void {
  const config = req.oauth;
  if (
    UNSUPPORTED.some((key) => Object.hasOwn(req, key)) ||
    (record(config) && UNSUPPORTED.some((key) => Object.hasOwn(config, key)))
  )
    throw new KernelError('ENOTSUP');
  const allowed = req.op === 'capabilities' ? COMMON : req.op === 'oauthGrant' ? GRANT : IDENTITY;
  if (!keys(req, allowed)) throw new KernelError('EINVAL');
  if (req.op === 'capabilities') return;
  if (
    typeof req.name !== 'string' ||
    !NAME.test(req.name) ||
    typeof req.provider !== 'string' ||
    !PROVIDER.test(req.provider) ||
    !nonempty(req.account) ||
    req.account.length > 256 ||
    CONTROL.test(req.account)
  )
    throw new KernelError('EINVAL');
  if (req.op !== 'oauthGrant') return;
  if (
    !nonempty(req.accessToken) ||
    (req.refreshToken !== undefined && !nonempty(req.refreshToken)) ||
    (req.tokenType !== undefined && typeof req.tokenType !== 'string') ||
    (req.expiresAt !== undefined && !epoch(req.expiresAt)) ||
    !record(config) ||
    !keys(config, CONFIG) ||
    !nonempty(config.tokenUrl) ||
    !nonempty(config.clientId) ||
    typeof config.authMethod !== 'string' ||
    (config.scope !== undefined && typeof config.scope !== 'string') ||
    (config.resource !== undefined && !nonempty(config.resource))
  )
    throw new KernelError('EINVAL');
  if (
    config.authMethod !== 'none' ||
    (typeof req.tokenType === 'string' && req.tokenType.toLowerCase() !== 'bearer')
  )
    throw new KernelError('ENOTSUP');
}

export function sealedOAuthError(
  code: keyof typeof MESSAGES = 'EIO',
  cause?: keyof typeof CAUSES
): SealedOAuthError {
  return {
    v: 1,
    error: { code, ...(cause ? { cause } : {}), message: cause ? CAUSES[cause] : MESSAGES[code] },
  };
}

export function sealedOAuthReply(op: string, value: unknown): SealedOAuthReply {
  try {
    return checkedReply(op, value) ?? sealedOAuthError();
  } catch {
    return sealedOAuthError();
  }
}

function checkedError(value: Record<string, unknown>): SealedOAuthError | undefined {
  const error = value.error;
  if (!exact(value, ['v', 'error']) || !record(error) || !Object.hasOwn(error, 'code'))
    return undefined;
  const { code, cause, message } = error;
  if (
    !keys(error, ['code', 'cause', 'message']) ||
    typeof code !== 'string' ||
    !Object.hasOwn(MESSAGES, code) ||
    (message !== undefined && typeof message !== 'string') ||
    (cause !== undefined && (typeof cause !== 'string' || !Object.hasOwn(CAUSES, cause)))
  )
    return undefined;
  return sealedOAuthError(code as keyof typeof MESSAGES, cause as keyof typeof CAUSES | undefined);
}

function checkedReply(op: string, value: unknown): SealedOAuthReply | undefined {
  if (!record(value) || !Object.hasOwn(value, 'v') || value.v !== 1) return undefined;
  if (Object.hasOwn(value, 'error')) return checkedError(value);
  if (op === 'capabilities') {
    const caps = value.capabilities;
    if (!exact(value, ['v', 'capabilities']) || !record(caps) || !keys(caps, ['kernelOAuth']))
      return undefined;
    if (Object.hasOwn(caps, 'kernelOAuth') && caps.kernelOAuth !== 1) return undefined;
    return { v: 1, capabilities: Object.hasOwn(caps, 'kernelOAuth') ? { kernelOAuth: 1 } : {} };
  }
  if (op === 'oauthRemove')
    return exact(value, ['v', 'removed']) && value.removed === true
      ? { v: 1, removed: true }
      : undefined;
  const { placeholder, state, expiresAt, refreshable } = value;
  if (
    !exact(value, ['v', 'placeholder', 'state', 'expiresAt', 'refreshable']) ||
    typeof placeholder !== 'string' ||
    !PLACEHOLDER.test(placeholder) ||
    typeof state !== 'string' ||
    !STATES.has(state) ||
    (expiresAt !== null && !epoch(expiresAt)) ||
    typeof refreshable !== 'boolean'
  )
    return undefined;
  return { v: 1, placeholder, state: state as SealedOAuthState, expiresAt, refreshable };
}
