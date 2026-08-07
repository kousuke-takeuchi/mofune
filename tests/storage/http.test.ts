import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpStorageProvider } from '../../src/storage/http'
import {
  InvalidPathError,
  NotFoundError,
  UnsupportedOperationError,
} from '../../src/storage/provider'
import { utf8, fromUtf8 } from '../../src/crypto/bytes'

function mockFetch(response: Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(response)),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpStorageProvider', () => {
  it('declares itself read-only', () => {
    const storage = new HttpStorageProvider('https://example.invalid/mofune')
    expect(storage.capabilities).toEqual({
      read: true,
      write: false,
      list: false,
      inbox: false,
    })
  })

  it('fetches an object by joining root and path', async () => {
    const fetchMock = vi.fn((_url: string) => Promise.resolve(new Response(utf8('payload'))))
    vi.stubGlobal('fetch', fetchMock)
    const storage = new HttpStorageProvider('https://example.invalid/mofune/')
    expect(fromUtf8(await storage.get('midori/manifest.json'))).toBe('payload')
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://example.invalid/mofune/midori/manifest.json',
    )
  })

  it('maps 404 to NotFoundError', async () => {
    mockFetch(new Response('', { status: 404 }))
    const storage = new HttpStorageProvider('https://example.invalid')
    await expect(storage.get('missing')).rejects.toThrow(NotFoundError)
  })

  it('maps 403 to NotFoundError because S3 hides missing objects that way', async () => {
    mockFetch(new Response('', { status: 403 }))
    const storage = new HttpStorageProvider('https://example.invalid')
    await expect(storage.get('missing')).rejects.toThrow(NotFoundError)
  })

  it('surfaces other HTTP failures as generic errors', async () => {
    mockFetch(new Response('', { status: 500 }))
    const storage = new HttpStorageProvider('https://example.invalid')
    await expect(storage.get('x')).rejects.toThrow(/500/)
  })

  it('rejects write and list operations', async () => {
    const storage = new HttpStorageProvider('https://example.invalid')
    await expect(storage.put('a', utf8('x'))).rejects.toThrow(UnsupportedOperationError)
    await expect(storage.list('a')).rejects.toThrow(UnsupportedOperationError)
    await expect(storage.delete('a')).rejects.toThrow(UnsupportedOperationError)
  })

  it('refuses a path that climbs out of the root', async () => {
    const storage = new HttpStorageProvider('https://example.invalid/mofune')
    await expect(storage.get('../other-group/roster.sig.json')).rejects.toThrow(InvalidPathError)
    await expect(storage.get('midori/../../../etc/passwd')).rejects.toThrow(InvalidPathError)
    await expect(storage.get('/absolute.json')).rejects.toThrow(InvalidPathError)
    await expect(storage.get('')).rejects.toThrow(InvalidPathError)
  })
})
