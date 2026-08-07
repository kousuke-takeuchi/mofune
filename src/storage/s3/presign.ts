import type { S3Credentials } from './sigv4'
import {
  ALGORITHM,
  UNSIGNED_PAYLOAD,
  amzTimestamps,
  calculateSignature,
  canonicalQueryString,
  canonicalRequest,
  credentialScope,
  signingKey,
  stringToSign,
} from './sigv4'

/** S3 が受け付ける presigned URL の有効期限の上限 (7 日)。 */
export const MAX_EXPIRES_IN = 604800

export interface PresignOptions {
  credentials: S3Credentials
  region: string
  method: 'GET' | 'PUT'
  /** スキームとホストまで。末尾のスラッシュは付けない。 */
  endpoint: string
  /** '/bucket/key' 形式のパス。 */
  path: string
  /** 秒。1 以上 MAX_EXPIRES_IN 以下。 */
  expiresIn: number
  now?: Date
}

export async function presignUrl(options: PresignOptions): Promise<string> {
  if (options.expiresIn < 1 || options.expiresIn > MAX_EXPIRES_IN) {
    throw new Error(`expiresIn must be between 1 and ${MAX_EXPIRES_IN}, got ${options.expiresIn}`)
  }
  const url = new URL(options.endpoint)
  const { amzDate, dateStamp } = amzTimestamps(options.now ?? new Date())
  const scope = credentialScope(dateStamp, options.region)

  const query: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${options.credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(options.expiresIn),
    'X-Amz-SignedHeaders': 'host',
  }

  const request = canonicalRequest({
    method: options.method,
    path: options.path,
    query,
    headers: { host: url.host },
    // クエリ署名では本文を署名対象にできない
    payloadHash: UNSIGNED_PAYLOAD,
  })
  const key = await signingKey(options.credentials.secretAccessKey, dateStamp, options.region)
  const signature = await calculateSignature(key, await stringToSign(amzDate, scope, request))

  return `${url.origin}${options.path}?${canonicalQueryString(query)}&X-Amz-Signature=${signature}`
}
