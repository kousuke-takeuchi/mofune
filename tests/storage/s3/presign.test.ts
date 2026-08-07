import { describe, it, expect } from 'vitest'
import { presignUrl } from '../../../src/storage/s3/presign'

const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}
const base = {
  credentials,
  region: 'us-east-1',
  endpoint: 'https://example.invalid',
  expiresIn: 3600,
  now: new Date('2026-08-07T09:12:34.000Z'),
}

describe('presignUrl', () => {
  it('keeps the endpoint origin and the object path', async () => {
    const url = new URL(await presignUrl({ ...base, method: 'PUT', path: '/bucket/inbox/u_a/1' }))
    expect(url.origin).toBe('https://example.invalid')
    expect(url.pathname).toBe('/bucket/inbox/u_a/1')
  })

  it('carries every required query parameter', async () => {
    const url = new URL(await presignUrl({ ...base, method: 'PUT', path: '/bucket/o' }))
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20260807/us-east-1/s3/aws4_request',
    )
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260807T091234Z')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces a different signature for GET and PUT', async () => {
    const get = new URL(await presignUrl({ ...base, method: 'GET', path: '/bucket/o' }))
    const put = new URL(await presignUrl({ ...base, method: 'PUT', path: '/bucket/o' }))
    expect(get.searchParams.get('X-Amz-Signature')).not.toBe(
      put.searchParams.get('X-Amz-Signature'),
    )
  })

  it('produces a different signature for a different object path', async () => {
    const a = new URL(await presignUrl({ ...base, method: 'PUT', path: '/bucket/inbox/u_a/1' }))
    const b = new URL(await presignUrl({ ...base, method: 'PUT', path: '/bucket/inbox/u_b/1' }))
    expect(a.searchParams.get('X-Amz-Signature')).not.toBe(b.searchParams.get('X-Amz-Signature'))
  })

  it('produces a different signature for a different expiry', async () => {
    const short = new URL(await presignUrl({ ...base, method: 'PUT', path: '/bucket/o' }))
    const long = new URL(
      await presignUrl({ ...base, method: 'PUT', path: '/bucket/o', expiresIn: 7200 }),
    )
    expect(short.searchParams.get('X-Amz-Signature')).not.toBe(
      long.searchParams.get('X-Amz-Signature'),
    )
  })

  it('is deterministic for the same inputs', async () => {
    const a = await presignUrl({ ...base, method: 'PUT', path: '/bucket/o' })
    const b = await presignUrl({ ...base, method: 'PUT', path: '/bucket/o' })
    expect(a).toBe(b)
  })

  it('percent-encodes the credential slashes in the query string', async () => {
    const raw = await presignUrl({ ...base, method: 'PUT', path: '/bucket/o' })
    expect(raw).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260807%2F')
  })

  it('rejects an expiry outside the range S3 accepts', async () => {
    await expect(
      presignUrl({ ...base, method: 'PUT', path: '/bucket/o', expiresIn: 0 }),
    ).rejects.toThrow(/expiresIn/)
    await expect(
      presignUrl({ ...base, method: 'PUT', path: '/bucket/o', expiresIn: 604801 }),
    ).rejects.toThrow(/expiresIn/)
  })
})
