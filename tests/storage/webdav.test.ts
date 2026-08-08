import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebdavStorageProvider } from '../../src/storage/webdav'
import { NotFoundError, UnsupportedOperationError } from '../../src/storage/provider'
import { utf8, fromUtf8 } from '../../src/crypto/bytes'

const base = 'https://nas.invalid/public.php/dav/files/TOKEN'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

let calls: Call[]

function respond(handler: (call: Call) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        url: String(url),
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body,
      }
      calls.push(call)
      return handler(call)
    }),
  )
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reading', () => {
  it('composes the url by appending the path, which is why WebDAV works at all', async () => {
    respond(() => new Response(utf8('sealed')))
    const provider = new WebdavStorageProvider({ baseUrl: base })

    const bytes = await provider.get('g_midori/messages/m_1.enc')

    expect(fromUtf8(bytes)).toBe('sealed')
    expect(calls[0]?.url).toBe(`${base}/g_midori/messages/m_1.enc`)
    expect(calls[0]?.method).toBe('GET')
    // 資格情報を渡していないなら、認証ヘッダも付けない
    expect(calls[0]?.headers.authorization).toBeUndefined()
  })

  it('sends basic auth when the group has credentials', async () => {
    respond(() => new Response(utf8('sealed')))
    const provider = new WebdavStorageProvider({
      baseUrl: base,
      credentials: { username: 'mofune', password: 'secret' },
    })

    await provider.get('g_midori/messages/m_1.enc')

    expect(calls[0]?.headers.authorization).toBe(`Basic ${btoa('mofune:secret')}`)
  })

  it('turns 404 into NotFoundError', async () => {
    respond(() => new Response(null, { status: 404 }))
    const provider = new WebdavStorageProvider({ baseUrl: base })
    await expect(provider.get('g_midori/messages/gone.enc')).rejects.toThrow(NotFoundError)
  })

  it('refuses a path that leaves the group', async () => {
    respond(() => new Response(utf8('x')))
    const provider = new WebdavStorageProvider({ baseUrl: base })
    await expect(provider.get('g_midori/../etc/passwd')).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe('writing', () => {
  it('will not write without credentials', async () => {
    respond(() => new Response(null, { status: 201 }))
    const provider = new WebdavStorageProvider({ baseUrl: base })
    expect(provider.capabilities.write).toBe(false)
    await expect(provider.put('g_midori/messages/m_1.enc', utf8('x'))).rejects.toThrow(
      UnsupportedOperationError,
    )
  })

  it('puts the bytes when the folders are already there', async () => {
    respond(() => new Response(null, { status: 201 }))
    const provider = new WebdavStorageProvider({
      baseUrl: base,
      credentials: { username: 'mofune', password: 'secret' },
    })

    await provider.put('g_midori/messages/m_1.enc', utf8('sealed'))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('PUT')
  })

  /**
   * WebDAV は親フォルダが無いと PUT を断る (409)。S3 のようにキーを置くだけでは
   * 済まないので、断られたら掘ってから置き直す。
   */
  it('creates the missing folders and puts again', async () => {
    let created = 0
    respond((call) => {
      if (call.method === 'MKCOL') {
        created += 1
        return new Response(null, { status: 201 })
      }
      // 最初の PUT だけ親が無くて断られる
      const firstPut = calls.filter((entry) => entry.method === 'PUT').length === 1
      return new Response(null, { status: firstPut ? 409 : 201 })
    })
    const provider = new WebdavStorageProvider({
      baseUrl: base,
      credentials: { username: 'mofune', password: 'secret' },
    })

    await provider.put('g_midori/inbox/u_sato/a.enc', utf8('sealed'))

    expect(created).toBe(3)
    const mkcols = calls.filter((call) => call.method === 'MKCOL').map((call) => call.url)
    // 上から順に掘る。順番を逆にすると、親の無い階層を作ろうとして失敗する
    expect(mkcols).toEqual([
      `${base}/g_midori`,
      `${base}/g_midori/inbox`,
      `${base}/g_midori/inbox/u_sato`,
    ])
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2)
  })

  it('does not dig twice for the same folder', async () => {
    let puts = 0
    respond((call) => {
      if (call.method === 'MKCOL') return new Response(null, { status: 201 })
      puts += 1
      return new Response(null, { status: puts === 1 ? 409 : 201 })
    })
    const provider = new WebdavStorageProvider({
      baseUrl: base,
      credentials: { username: 'mofune', password: 'secret' },
    })

    await provider.put('g_midori/events/e_1.enc', utf8('a'))
    const digs = calls.filter((call) => call.method === 'MKCOL').length
    await provider.put('g_midori/events/e_2.enc', utf8('b'))

    expect(calls.filter((call) => call.method === 'MKCOL')).toHaveLength(digs)
  })
})

describe('listing', () => {
  const propfind = `<?xml version="1.0"?>
    <d:multistatus xmlns:d="DAV:">
      <d:response>
        <d:href>/public.php/dav/files/TOKEN/g_midori/events/</d:href>
        <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
      </d:response>
      <d:response>
        <d:href>/public.php/dav/files/TOKEN/g_midori/events/e_2.enc</d:href>
        <d:propstat><d:prop><d:getcontentlength>4</d:getcontentlength></d:prop></d:propstat>
      </d:response>
      <d:response>
        <d:href>/public.php/dav/files/TOKEN/g_midori/events/e_1.enc</d:href>
        <d:propstat><d:prop><d:getcontentlength>3</d:getcontentlength></d:prop></d:propstat>
      </d:response>
    </d:multistatus>`

  it('asks only one level deep and returns the children in order', async () => {
    respond(() => new Response(propfind, { status: 207 }))
    const provider = new WebdavStorageProvider({ baseUrl: base })

    const entries = await provider.list('g_midori/events/')

    expect(calls[0]?.method).toBe('PROPFIND')
    expect(calls[0]?.headers.depth).toBe('1')
    expect(entries).toEqual([
      { path: 'g_midori/events/e_1.enc', size: 3 },
      { path: 'g_midori/events/e_2.enc', size: 4 },
    ])
  })

  it('leaves out the folder itself, which PROPFIND always includes', async () => {
    respond(() => new Response(propfind, { status: 207 }))
    const provider = new WebdavStorageProvider({ baseUrl: base })
    const entries = await provider.list('g_midori/events/')
    expect(entries.map((entry) => entry.path)).not.toContain('g_midori/events/')
  })

  it('returns only what comes after the cursor', async () => {
    respond(() => new Response(propfind, { status: 207 }))
    const provider = new WebdavStorageProvider({ baseUrl: base })
    const entries = await provider.list('g_midori/events/', 'g_midori/events/e_1.enc')
    expect(entries.map((entry) => entry.path)).toEqual(['g_midori/events/e_2.enc'])
  })

  it('treats a missing folder as nothing rather than an error', async () => {
    respond(() => new Response(null, { status: 404 }))
    const provider = new WebdavStorageProvider({ baseUrl: base })
    expect(await provider.list('g_midori/events/')).toEqual([])
  })
})

describe('capabilities', () => {
  it('says there is no way for a participant to post without credentials', () => {
    // WebDAV に presigned URL は無い。上りは関数の引換券に頼る
    expect(new WebdavStorageProvider({ baseUrl: base }).capabilities.inbox).toBe(false)
  })
})
