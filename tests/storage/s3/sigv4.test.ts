import { describe, it, expect } from 'vitest'
import { SignatureV4 } from '@smithy/signature-v4'
import { HttpRequest } from '@smithy/protocol-http'
import { Sha256 } from '@aws-crypto/sha256-js'
import {
  ALGORITHM,
  amzTimestamps,
  canonicalHeaders,
  canonicalQueryString,
  canonicalRequest,
  credentialScope,
  signRequestHeaders,
  uriEncode,
} from '../../../src/storage/s3/sigv4'

const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}
const region = 'us-east-1'
const now = new Date('2026-08-07T09:12:34.000Z')

/**
 * AWS 公式実装で「まったく同じリクエスト」に署名し、Authorization ヘッダを返す。
 * 自前実装が生成したヘッダをそのまま渡すのが要点。片方だけ x-amz-content-sha256 を
 * 持つ状態で比較すると、署名対象が違うので当然一致しない。
 * ここで渡すのは署名の入力であり、比較するのは出力(署名)なので、
 * オラクルとしての独立性は保たれる。
 */
async function oracleAuthorization(
  method: string,
  url: URL,
  produced: Record<string, string>,
): Promise<string> {
  const headers: Record<string, string> = { ...produced }
  delete headers['Authorization']
  const signer = new SignatureV4({
    service: 's3',
    region,
    credentials,
    sha256: Sha256,
    uriEscapePath: false,
    applyChecksum: false,
  })
  const query: Record<string, string> = {}
  url.searchParams.forEach((value, key) => {
    query[key] = value
  })
  const signed = await signer.sign(
    new HttpRequest({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query,
      headers: { host: url.host, ...headers },
    }),
    { signingDate: now },
  )
  return signed.headers['authorization'] as string
}

describe('uriEncode', () => {
  it('leaves unreserved characters alone', () => {
    expect(uriEncode('abcXYZ019-._~', true)).toBe('abcXYZ019-._~')
  })

  it('percent-encodes spaces as %20 rather than +', () => {
    expect(uriEncode('a b', true)).toBe('a%20b')
  })

  it('encodes slashes only when asked', () => {
    expect(uriEncode('a/b', true)).toBe('a%2Fb')
    expect(uriEncode('a/b', false)).toBe('a/b')
  })

  it('uses uppercase hex', () => {
    expect(uriEncode('~!', true)).toBe('~%21')
  })

  it('encodes multibyte characters as their UTF-8 bytes', () => {
    expect(uriEncode('あ', true)).toBe('%E3%81%82')
  })
})

describe('canonicalQueryString', () => {
  it('sorts parameters by name', () => {
    expect(canonicalQueryString({ b: '2', a: '1' })).toBe('a=1&b=2')
  })

  it('encodes both names and values including slashes', () => {
    expect(canonicalQueryString({ 'X-Amz-Credential': 'AK/20260807' })).toBe(
      'X-Amz-Credential=AK%2F20260807',
    )
  })

  it('returns an empty string for no parameters', () => {
    expect(canonicalQueryString({})).toBe('')
  })
})

describe('canonicalHeaders', () => {
  it('lowercases names, sorts them and terminates each line with a newline', () => {
    const result = canonicalHeaders({ 'X-Amz-Date': '20260807T091234Z', Host: 'example.com' })
    expect(result.canonical).toBe('host:example.com\nx-amz-date:20260807T091234Z\n')
    expect(result.signed).toBe('host;x-amz-date')
  })

  it('trims and collapses whitespace in values', () => {
    expect(canonicalHeaders({ a: '  x   y  ' }).canonical).toBe('a:x y\n')
  })
})

describe('canonicalRequest', () => {
  it('joins the six elements with newlines and does not add a trailing newline', () => {
    const text = canonicalRequest({
      method: 'get',
      path: '/bucket/midori/manifest.json',
      query: {},
      headers: { host: 'example.com' },
      payloadHash: 'HASH',
    })
    expect(text).toBe(
      ['GET', '/bucket/midori/manifest.json', '', 'host:example.com\n', 'host', 'HASH'].join('\n'),
    )
    expect(text.endsWith('\n')).toBe(false)
  })
})

describe('amzTimestamps', () => {
  it('formats the ISO 8601 basic timestamp and the date stamp', () => {
    expect(amzTimestamps(now)).toEqual({ amzDate: '20260807T091234Z', dateStamp: '20260807' })
  })
})

describe('credentialScope', () => {
  it('joins date, region, service and the termination string', () => {
    expect(credentialScope('20260807', 'us-east-1')).toBe('20260807/us-east-1/s3/aws4_request')
  })
})

describe('signRequestHeaders (checked against the AWS reference implementation)', () => {
  it('matches the oracle for a simple GET', async () => {
    const url = new URL('https://example.invalid/bucket/midori/manifest.json')
    const headers = await signRequestHeaders({ credentials, region, method: 'GET', url, now })
    expect(headers['Authorization']).toBe(await oracleAuthorization('GET', url, headers))
  })

  it('matches the oracle for a PUT with a body', async () => {
    const url = new URL('https://example.invalid/bucket/midori/events/1-a.enc')
    const payload = new Uint8Array([1, 2, 3, 4])
    const headers = await signRequestHeaders({
      credentials,
      region,
      method: 'PUT',
      url,
      payload,
      now,
    })
    expect(headers['Authorization']).toBe(await oracleAuthorization('PUT', url, headers))
  })

  it('matches the oracle for a request with query parameters', async () => {
    const url = new URL(
      'https://example.invalid/bucket?list-type=2&prefix=midori%2Fevents%2F&max-keys=1000',
    )
    const headers = await signRequestHeaders({ credentials, region, method: 'GET', url, now })
    expect(headers['Authorization']).toBe(await oracleAuthorization('GET', url, headers))
  })

  it('announces the algorithm and the credential scope in the header', async () => {
    const url = new URL('https://example.invalid/bucket/midori/manifest.json')
    const headers = await signRequestHeaders({ credentials, region, method: 'GET', url, now })
    expect(headers['Authorization']).toContain(ALGORITHM)
    expect(headers['Authorization']).toContain(
      `Credential=${credentials.accessKeyId}/20260807/us-east-1/s3/aws4_request`,
    )
  })

  it('sends the payload hash of an empty body when there is no payload', async () => {
    const url = new URL('https://example.invalid/bucket/midori/manifest.json')
    const headers = await signRequestHeaders({ credentials, region, method: 'GET', url, now })
    // SHA-256 of the empty string, computed rather than hard-coded
    const empty = await crypto.subtle.digest('SHA-256', new Uint8Array(0))
    const hex = [...new Uint8Array(empty)].map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(headers['x-amz-content-sha256']).toBe(hex)
  })
})
