import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { WebdavStorageProvider } from '../../src/storage/webdav'
import { NotFoundError } from '../../src/storage/provider'
import { utf8, fromUtf8 } from '../../src/crypto/bytes'

/**
 * WebDAV の作法をそのまま守るサーバーを立てて、本番のプロバイダで叩く。
 *
 * とくに「**親フォルダが無ければ PUT は 409**」を本物どおりに返す。S3 と同じ
 * つもりでキーを置くコードは、ここで必ず落ちる。
 */

const USER = 'mofune'
const PASSWORD = 'secret'

let server: Server
let base: string
let folders: Set<string>
let files: Map<string, Buffer>

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

function authorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization ?? ''
  if (!header.startsWith('Basic ')) return false
  const [user, password] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':')
  return user === USER && password === PASSWORD
}

function parentOf(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void (async () => {
      const path = decodeURIComponent((request.url ?? '/').replace(/^\/dav\/?/, '')).replace(
        /\/+$/,
        '',
      )
      const method = request.method ?? 'GET'
      const body = await readBody(request)
      const needsAuth = method !== 'GET' && method !== 'PROPFIND'

      if (needsAuth && !authorized(request)) {
        response.writeHead(401).end()
        return
      }

      if (method === 'GET') {
        const found = files.get(path)
        if (!found) {
          response.writeHead(404).end()
          return
        }
        response.writeHead(200).end(found)
        return
      }

      if (method === 'MKCOL') {
        // 親が無ければ掘れない。これも WebDAV の作法
        const parent = parentOf(path)
        if (parent !== '' && !folders.has(parent)) {
          response.writeHead(409).end()
          return
        }
        folders.add(path)
        response.writeHead(201).end()
        return
      }

      if (method === 'PUT') {
        const parent = parentOf(path)
        if (parent !== '' && !folders.has(parent)) {
          response.writeHead(409).end()
          return
        }
        files.set(path, body)
        response.writeHead(201).end()
        return
      }

      if (method === 'DELETE') {
        files.delete(path)
        response.writeHead(204).end()
        return
      }

      if (method === 'PROPFIND') {
        if (!folders.has(path)) {
          response.writeHead(404).end()
          return
        }
        const children = [...files.entries()].filter(([key]) => parentOf(key) === path)
        const xml = [
          '<?xml version="1.0"?>',
          '<d:multistatus xmlns:d="DAV:">',
          `<d:response><d:href>/dav/${path}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`,
          ...children.map(
            ([key, value]) =>
              `<d:response><d:href>/dav/${key}</d:href><d:propstat><d:prop><d:getcontentlength>${String(
                value.length,
              )}</d:getcontentlength></d:prop></d:propstat></d:response>`,
          ),
          '</d:multistatus>',
        ].join('')
        response.writeHead(207, { 'content-type': 'application/xml' }).end(xml)
        return
      }

      response.writeHead(405).end()
    })()
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      base = `http://127.0.0.1:${port}/dav`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  folders = new Set<string>([''])
  files = new Map<string, Buffer>()
})

function writer(): WebdavStorageProvider {
  return new WebdavStorageProvider({
    baseUrl: base,
    credentials: { username: USER, password: PASSWORD },
  })
}

function reader(): WebdavStorageProvider {
  return new WebdavStorageProvider({ baseUrl: base })
}

describe('a real WebDAV server', () => {
  it('takes a write into folders that do not exist yet', async () => {
    await writer().put('g_midori/inbox/u_sato/a.enc', utf8('sealed'))
    expect(fromUtf8(await reader().get('g_midori/inbox/u_sato/a.enc'))).toBe('sealed')
  })

  it('lets a participant read without any credentials', async () => {
    await writer().put('g_midori/messages/m_1.enc', utf8('sealed'))
    expect(fromUtf8(await reader().get('g_midori/messages/m_1.enc'))).toBe('sealed')
  })

  it('keeps bytes intact, including ones that are not text', async () => {
    const bytes = new Uint8Array([0, 13, 10, 250, 255]) as never
    await writer().put('g_midori/files/f_1.enc', bytes)
    expect(Array.from(await reader().get('g_midori/files/f_1.enc'))).toEqual([0, 13, 10, 250, 255])
  })

  it('lists a folder in order, and honours the cursor', async () => {
    const provider = writer()
    await provider.put('g_midori/events/e_2.enc', utf8('bb'))
    await provider.put('g_midori/events/e_1.enc', utf8('a'))

    const entries = await reader().list('g_midori/events/')
    expect(entries).toEqual([
      { path: 'g_midori/events/e_1.enc', size: 1 },
      { path: 'g_midori/events/e_2.enc', size: 2 },
    ])
    expect(await reader().list('g_midori/events/', 'g_midori/events/e_1.enc')).toEqual([
      { path: 'g_midori/events/e_2.enc', size: 2 },
    ])
  })

  it('says nothing is there for a folder that was never made', async () => {
    expect(await reader().list('g_midori/events/')).toEqual([])
  })

  it('refuses a write from someone with no credentials', async () => {
    await expect(reader().put('g_midori/messages/m_1.enc', utf8('x'))).rejects.toThrow()
  })

  it('deletes, and then the object is gone', async () => {
    await writer().put('g_midori/messages/m_1.enc', utf8('x'))
    await writer().delete('g_midori/messages/m_1.enc')
    await expect(reader().get('g_midori/messages/m_1.enc')).rejects.toThrow(NotFoundError)
  })
})
