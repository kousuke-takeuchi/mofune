import { describe, it, expect, vi, afterEach } from 'vitest'
import { S3StorageProvider } from '../../src/storage/s3'
import { NotFoundError } from '../../src/storage/provider'
import { fromUtf8, utf8 } from '../../src/crypto/bytes'

const config = {
  endpoint: 'https://example.invalid',
  region: 'auto',
  bucket: 'mofune',
  credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
}

function mockFetch(responses: Response[]): { calls: Call[] } {
  const calls: Call[] = []
  let index = 0
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    const response = responses[index] ?? responses[responses.length - 1]
    index += 1
    return Promise.resolve(response as Response)
  })
  return { calls }
}

const listPage = (truncated: boolean, keys: string[], token?: string) =>
  new Response(
    `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>` +
      (token ? `<NextContinuationToken>${token}</NextContinuationToken>` : '') +
      keys.map((key) => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`).join('') +
      `</ListBucketResult>`,
  )

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('S3StorageProvider', () => {
  it('declares that it can read, write, list and accept inbox uploads', () => {
    expect(new S3StorageProvider(config).capabilities).toEqual({
      read: true,
      write: true,
      list: true,
      inbox: true,
    })
  })

  it('gets an object from bucket and path', async () => {
    const { calls } = mockFetch([new Response(utf8('payload'))])
    const storage = new S3StorageProvider(config)
    expect(fromUtf8(await storage.get('midori/manifest.json'))).toBe('payload')
    expect(calls[0]?.url).toBe('https://example.invalid/mofune/midori/manifest.json')
    expect(calls[0]?.method).toBe('GET')
  })

  it('signs every request', async () => {
    const { calls } = mockFetch([new Response(utf8('payload'))])
    await new S3StorageProvider(config).get('midori/manifest.json')
    expect(calls[0]?.headers['Authorization']).toContain('AWS4-HMAC-SHA256')
    expect(calls[0]?.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
  })

  it('maps 404 to NotFoundError', async () => {
    mockFetch([new Response('', { status: 404 })])
    await expect(new S3StorageProvider(config).get('midori/missing')).rejects.toThrow(
      NotFoundError,
    )
  })

  it('reports other HTTP failures with the status code', async () => {
    mockFetch([new Response('denied', { status: 403 })])
    await expect(new S3StorageProvider(config).get('midori/manifest.json')).rejects.toThrow(/403/)
  })

  it('puts an object with the body and a signed payload hash', async () => {
    const { calls } = mockFetch([new Response('', { status: 200 })])
    await new S3StorageProvider(config).put('midori/events/1-a.enc', utf8('body'))
    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.url).toBe('https://example.invalid/mofune/midori/events/1-a.enc')
    expect(calls[0]?.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('deletes an object', async () => {
    const { calls } = mockFetch([new Response(null, { status: 204 })])
    await new S3StorageProvider(config).delete('midori/events/1-a.enc')
    expect(calls[0]?.method).toBe('DELETE')
  })

  it('lists a single page', async () => {
    mockFetch([listPage(false, ['midori/events/a.enc', 'midori/events/b.enc'])])
    const entries = await new S3StorageProvider(config).list('midori/events/')
    expect(entries.map((entry) => entry.path)).toEqual([
      'midori/events/a.enc',
      'midori/events/b.enc',
    ])
  })

  it('follows the continuation token across pages', async () => {
    const { calls } = mockFetch([
      listPage(true, ['midori/events/a.enc'], 'TOKEN1'),
      listPage(false, ['midori/events/b.enc']),
    ])
    const entries = await new S3StorageProvider(config).list('midori/events/')
    expect(entries.map((entry) => entry.path)).toEqual([
      'midori/events/a.enc',
      'midori/events/b.enc',
    ])
    expect(calls).toHaveLength(2)
    expect(calls[1]?.url).toContain('continuation-token=TOKEN1')
  })

  it('passes the cursor to start-after so only newer objects come back', async () => {
    const { calls } = mockFetch([listPage(false, [])])
    await new S3StorageProvider(config).list('midori/events/', 'midori/events/a.enc')
    expect(calls[0]?.url).toContain('start-after=midori%2Fevents%2Fa.enc')
  })

  it('sends list-type=2 and the prefix', async () => {
    const { calls } = mockFetch([listPage(false, [])])
    await new S3StorageProvider(config).list('midori/events/')
    expect(calls[0]?.url).toContain('list-type=2')
    expect(calls[0]?.url).toContain('prefix=midori%2Fevents%2F')
  })
})
