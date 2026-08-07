import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from '../crypto/bytes'

export class ConnectionCodeError extends Error {}

export const CONNECTION_CODE_VERSION = 1

export type ProviderKind = 'http' | 's3' | 'gdrive' | 'dropbox' | 'webdav'

const PROVIDER_KINDS: readonly ProviderKind[] = [
  'http',
  's3',
  'gdrive',
  'dropbox',
  'webdav',
]

export interface ConnectionCode {
  v: number
  groupId: string
  provider: ProviderKind
  /** バケット URL やフォルダ ID など、プロバイダ固有のルート位置 */
  root: string
  /** KDF ペッパー。ストレージには置かず、このコードだけが運ぶ。 */
  pepper: string
  /** base64, raw ECDSA public key。名簿検証の信頼の根。 */
  adminPublicKey: string
}

export function encodeConnectionCode(code: ConnectionCode): string {
  return toBase64Url(utf8(JSON.stringify(code)))
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConnectionCodeError(`connection code field "${field}" is missing`)
  }
  return value
}

export function decodeConnectionCode(text: string): ConnectionCode {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(fromBase64Url(text.trim())))
  } catch {
    throw new ConnectionCodeError('connection code is not readable')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new ConnectionCodeError('connection code is not an object')
  }
  const candidate = parsed as Record<string, unknown>
  if (candidate.v !== CONNECTION_CODE_VERSION) {
    throw new ConnectionCodeError(
      `unsupported connection code version ${String(candidate.v)}`,
    )
  }
  const provider = candidate.provider
  if (typeof provider !== 'string' || !PROVIDER_KINDS.includes(provider as ProviderKind)) {
    throw new ConnectionCodeError(`unsupported storage provider "${String(provider)}"`)
  }
  return {
    v: CONNECTION_CODE_VERSION,
    groupId: requireNonEmptyString(candidate.groupId, 'groupId'),
    provider: provider as ProviderKind,
    root: requireNonEmptyString(candidate.root, 'root'),
    pepper: requireNonEmptyString(candidate.pepper, 'pepper'),
    adminPublicKey: requireNonEmptyString(candidate.adminPublicKey, 'adminPublicKey'),
  }
}
