import { describe, it, expect } from 'vitest'
import { checkConnection } from '../../src/group/connection-check'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { UnsupportedOperationError } from '../../src/storage/provider'
import type { StorageProvider } from '../../src/storage/provider'
import type { Bytes } from '../../src/crypto/bytes'

function failingAt(stage: 'put' | 'get' | 'delete'): StorageProvider {
  const inner = new MemoryStorageProvider()
  return {
    capabilities: inner.capabilities,
    put: (path: string, data: Bytes) =>
      stage === 'put' ? Promise.reject(new Error('denied')) : inner.put(path, data),
    get: (path: string) =>
      stage === 'get' ? Promise.reject(new Error('cors')) : inner.get(path),
    delete: (path: string) =>
      stage === 'delete'
        ? Promise.reject(new UnsupportedOperationError('read-only'))
        : inner.delete(path),
    list: (prefix: string, after?: string) => inner.list(prefix, after),
  }
}

describe('checkConnection', () => {
  it('passes every step against a working provider', async () => {
    const result = await checkConnection({ storage: new MemoryStorageProvider(), groupId: 'midori' })
    expect(result.ok).toBe(true)
    expect(result.steps.every((step) => step.ok)).toBe(true)
  })

  it('reports the three steps it checks', async () => {
    const result = await checkConnection({ storage: new MemoryStorageProvider(), groupId: 'midori' })
    expect(result.steps).toHaveLength(3)
    expect(result.steps.map((step) => step.name)).toEqual(['write', 'read', 'delete'])
  })

  it('leaves nothing behind when it succeeds', async () => {
    const storage = new MemoryStorageProvider()
    await checkConnection({ storage, groupId: 'midori' })
    expect(await storage.list('midori/')).toHaveLength(0)
  })

  it('fails at the write step when the credentials are wrong', async () => {
    const result = await checkConnection({ storage: failingAt('put'), groupId: 'midori' })
    expect(result.ok).toBe(false)
    expect(result.steps[0]).toMatchObject({ name: 'write', ok: false })
  })

  it('does not attempt the later steps once writing fails', async () => {
    const result = await checkConnection({ storage: failingAt('put'), groupId: 'midori' })
    expect(result.steps).toHaveLength(1)
  })

  it('fails at the read step when the object cannot be fetched back', async () => {
    const result = await checkConnection({ storage: failingAt('get'), groupId: 'midori' })
    expect(result.ok).toBe(false)
    expect(result.steps.map((step) => step.name)).toEqual(['write', 'read'])
    expect(result.steps[1]?.ok).toBe(false)
  })

  it('fails at the delete step when cleanup is not allowed', async () => {
    const result = await checkConnection({ storage: failingAt('delete'), groupId: 'midori' })
    expect(result.ok).toBe(false)
    expect(result.steps[2]).toMatchObject({ name: 'delete', ok: false })
  })

  it('explains what went wrong rather than throwing', async () => {
    const result = await checkConnection({ storage: failingAt('put'), groupId: 'midori' })
    expect(result.steps[0]?.detail.length).toBeGreaterThan(0)
  })

  it('detects storage that returns different bytes than were written', async () => {
    const inner = new MemoryStorageProvider()
    const lying: StorageProvider = {
      capabilities: inner.capabilities,
      put: (path, data) => inner.put(path, data),
      get: async () => new TextEncoder().encode('something else') as Bytes,
      delete: (path) => inner.delete(path),
      list: (prefix, after) => inner.list(prefix, after),
    }
    const result = await checkConnection({ storage: lying, groupId: 'midori' })
    expect(result.ok).toBe(false)
    expect(result.steps[1]?.ok).toBe(false)
  })
})
