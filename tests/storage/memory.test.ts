import { describe, it, expect } from 'vitest'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { NotFoundError } from '../../src/storage/provider'
import { utf8, fromUtf8 } from '../../src/crypto/bytes'

describe('MemoryStorageProvider', () => {
  it('stores and returns bytes', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('a/b.json', utf8('hello'))
    expect(fromUtf8(await storage.get('a/b.json'))).toBe('hello')
  })

  it('throws NotFoundError for a missing path', async () => {
    const storage = new MemoryStorageProvider()
    await expect(storage.get('missing')).rejects.toThrow(NotFoundError)
  })

  it('overwrites an existing path', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('a', utf8('one'))
    await storage.put('a', utf8('two'))
    expect(fromUtf8(await storage.get('a'))).toBe('two')
  })

  it('lists paths under a prefix in sorted order', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('g/events/2.enc', utf8('b'))
    await storage.put('g/events/1.enc', utf8('a'))
    await storage.put('g/messages/1.enc', utf8('c'))
    expect((await storage.list('g/events/')).map((entry) => entry.path)).toEqual([
      'g/events/1.enc',
      'g/events/2.enc',
    ])
  })

  it('reports the stored size', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('a', utf8('12345'))
    expect((await storage.list('a'))[0]?.size).toBe(5)
  })

  it('deletes a path', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('a', utf8('x'))
    await storage.delete('a')
    await expect(storage.get('a')).rejects.toThrow(NotFoundError)
  })

  it('returns a defensive copy so callers cannot mutate stored bytes', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('a', utf8('hello'))
    const first = await storage.get('a')
    first[0] = 0
    expect(fromUtf8(await storage.get('a'))).toBe('hello')
  })

  it('can be seeded from a map of objects', async () => {
    const storage = new MemoryStorageProvider(new Map([['a', utf8('seeded')]]))
    expect(fromUtf8(await storage.get('a'))).toBe('seeded')
  })
})
