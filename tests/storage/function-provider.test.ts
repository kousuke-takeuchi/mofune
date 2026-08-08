import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { FunctionStorageProvider, inboxTicket } from '../../src/storage/function'
import { NotFoundError, UnsupportedOperationError } from '../../src/storage/provider'
import { utf8, fromUtf8 } from '../../src/crypto/bytes'

const url = 'https://script.google.com/macros/s/AKfycbx/exec'

function b64(text: string): string {
  return btoa(text)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FunctionStorageProvider', () => {
  let calls: ReturnType<typeof vi.fn>

  beforeEach(() => {
    calls = vi.fn(async () => Response.json({ body: b64('sealed') }))
    vi.stubGlobal('fetch', calls)
  })

  it('reads without a secret, because the bytes are sealed', async () => {
    const provider = new FunctionStorageProvider({ functionUrl: url, groupId: 'g_midori' })
    const bytes = await provider.get('g_midori/messages/m_1.enc')

    expect(fromUtf8(bytes)).toBe('sealed')
    const [called] = calls.mock.calls[0] as unknown as [string]
    expect(called).toContain('path=%2Fobject')
    expect(called).toContain('key=g_midori%2Fmessages%2Fm_1.enc')
  })

  it('turns a missing object into NotFoundError, like every other provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'not found' })))
    const provider = new FunctionStorageProvider({ functionUrl: url, groupId: 'g_midori' })
    await expect(provider.get('g_midori/messages/gone.enc')).rejects.toThrow(NotFoundError)
  })

  it('refuses to write without the group secret', async () => {
    const provider = new FunctionStorageProvider({ functionUrl: url, groupId: 'g_midori' })
    expect(provider.capabilities.write).toBe(false)
    await expect(provider.put('g_midori/messages/m_1.enc', utf8('x'))).rejects.toThrow(
      UnsupportedOperationError,
    )
  })

  it('writes with the secret, sending the bytes as base64', async () => {
    calls = vi.fn(async () => Response.json({ ok: true }))
    vi.stubGlobal('fetch', calls)
    const provider = new FunctionStorageProvider({
      functionUrl: url,
      groupId: 'g_midori',
      token: 'shared-secret',
    })
    expect(provider.capabilities.write).toBe(true)

    await provider.put('g_midori/messages/m_1.enc', utf8('sealed'))

    const [, init] = calls.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      group_id: 'g_midori',
      key: 'g_midori/messages/m_1.enc',
      body: b64('sealed'),
      token: 'shared-secret',
    })
  })

  it('can list, which a public bucket cannot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          entries: [
            { key: 'g_midori/events/e_2.enc', size: 4 },
            { key: 'g_midori/events/e_1.enc', size: 3 },
          ],
        }),
      ),
    )
    const provider = new FunctionStorageProvider({ functionUrl: url, groupId: 'g_midori' })
    expect(provider.capabilities.list).toBe(true)

    const entries = await provider.list('g_midori/events/')
    // 差分同期は辞書順に頼るので、順番はこちらで揃える
    expect(entries.map((entry) => entry.path)).toEqual([
      'g_midori/events/e_1.enc',
      'g_midori/events/e_2.enc',
    ])
  })

  it('returns only what comes after the cursor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          entries: [
            { key: 'g_midori/events/e_1.enc', size: 3 },
            { key: 'g_midori/events/e_2.enc', size: 4 },
          ],
        }),
      ),
    )
    const provider = new FunctionStorageProvider({ functionUrl: url, groupId: 'g_midori' })
    const entries = await provider.list('g_midori/events/', 'g_midori/events/e_1.enc')
    expect(entries.map((entry) => entry.path)).toEqual(['g_midori/events/e_2.enc'])
  })

  it('refuses a path that leaves the group', async () => {
    const provider = new FunctionStorageProvider({ functionUrl: url, groupId: 'g_midori' })
    await expect(provider.get('g_midori/../g_other/manifest.json')).rejects.toThrow()
  })
})

describe('inboxTicket', () => {
  it('is the same on both sides for the same key', async () => {
    const first = await inboxTicket('shared-secret', 'g_midori/inbox/u_sato/a.enc')
    const second = await inboxTicket('shared-secret', 'g_midori/inbox/u_sato/a.enc')
    expect(first).toBe(second)
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('is different for another key, so one ticket cannot be spent elsewhere', async () => {
    const mine = await inboxTicket('shared-secret', 'g_midori/inbox/u_sato/a.enc')
    const other = await inboxTicket('shared-secret', 'g_midori/inbox/u_mori/a.enc')
    expect(mine).not.toBe(other)
  })

  it('is different under another secret', async () => {
    const mine = await inboxTicket('shared-secret', 'g_midori/inbox/u_sato/a.enc')
    const other = await inboxTicket('another-secret', 'g_midori/inbox/u_sato/a.enc')
    expect(mine).not.toBe(other)
  })
})
