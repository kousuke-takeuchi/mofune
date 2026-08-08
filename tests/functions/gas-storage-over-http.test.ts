import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
// @ts-expect-error GAS へそのまま貼る素の JS。型宣言は持たせない
import { handleRequest } from '../../functions/gas/logic.js'
import { FunctionStorageProvider, inboxTicket } from '../../src/storage/function'
import { NotFoundError } from '../../src/storage/provider'
import { utf8, fromUtf8 } from '../../src/crypto/bytes'
import { createHmac } from 'node:crypto'

/**
 * Drive を置き場にする経路を、素の HTTP で端から端まで通す。
 *
 * Apps Script の癖 (パスは ?path=、合言葉は本文、失敗も 200) をそのまま真似た
 * サーバーに、アプリが本番で使うプロバイダをつないで動かす。ここを通しておかないと、
 * 「単体テストは通るのに本番の Apps Script でだけ落ちる」経路が残る。
 */

const TOKEN = 'shared-secret'
const files = new Map<string, string>()
let server: Server
let origin: string

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

/** GAS 側の Utilities.computeHmacSha256Signature に当たるもの。 */
function verifyTicket(key: string, ticket: string): boolean {
  const expected = createHmac('sha256', TOKEN).update(key).digest('base64url')
  return expected === ticket
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const raw = await readBody(request)
      let body: unknown = {}
      try {
        body = raw === '' ? {} : JSON.parse(raw)
      } catch {
        body = {}
      }
      const query: Record<string, string> = {}
      url.searchParams.forEach((value, name) => {
        query[name] = value
      })

      const result = handleRequest(
        {
          path: query.path ?? '/',
          method: request.method,
          body,
          authorization: '',
          query,
        },
        {
          store: { get: () => null, put: () => undefined },
          tokens: { g_midori: TOKEN },
          vapidPublicKey: 'BPUB',
          sendPush: () => 201,
          drive: {
            get: (key: string) => files.get(key) ?? null,
            put: (key: string, value: string) => void files.set(key, value),
            remove: (key: string) => void files.delete(key),
            list: (prefix: string) =>
              [...files.entries()]
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, value]) => ({ key, size: value.length })),
          },
          verifyTicket,
        },
      )
      // Apps Script はいつでも 200 で返す
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result.body))
    })()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      origin = `http://127.0.0.1:${port}/macros/s/test/exec`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function reader(): FunctionStorageProvider {
  return new FunctionStorageProvider({ functionUrl: origin, groupId: 'g_midori' })
}

function writer(): FunctionStorageProvider {
  return new FunctionStorageProvider({ functionUrl: origin, groupId: 'g_midori', token: TOKEN })
}

describe('Drive as the storage, through the function', () => {
  it('writes with the secret and reads back without one', async () => {
    await writer().put('g_midori/messages/m_1.enc', utf8('sealed bytes'))
    expect(fromUtf8(await reader().get('g_midori/messages/m_1.enc'))).toBe('sealed bytes')
  })

  it('keeps bytes intact, including ones that are not text', async () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 13, 10]) as never
    await writer().put('g_midori/files/f_1.enc', bytes)
    expect(Array.from(await reader().get('g_midori/files/f_1.enc'))).toEqual([0, 1, 250, 255, 13, 10])
  })

  it('lists a prefix in order, which the participant path needs for syncing', async () => {
    await writer().put('g_midori/events/e_2.enc', utf8('b'))
    await writer().put('g_midori/events/e_1.enc', utf8('a'))

    const entries = await reader().list('g_midori/events/')
    expect(entries.map((entry) => entry.path)).toEqual([
      'g_midori/events/e_1.enc',
      'g_midori/events/e_2.enc',
    ])
    expect(await reader().list('g_midori/events/', 'g_midori/events/e_1.enc')).toHaveLength(1)
  })

  it('lets a participant drop into the inbox with a ticket from the staff', async () => {
    const key = 'g_midori/inbox/u_sato/a.enc'
    const ticket = await inboxTicket(TOKEN, key)

    await reader().submitToInbox(key, utf8('sealed for staff'), ticket)

    expect(fromUtf8(await reader().get(key))).toBe('sealed for staff')
  })

  it('turns away a drop whose ticket was made for somewhere else', async () => {
    const ticket = await inboxTicket(TOKEN, 'g_midori/inbox/u_sato/a.enc')
    await expect(
      reader().submitToInbox('g_midori/inbox/u_mori/a.enc', utf8('x'), ticket),
    ).rejects.toThrow()
  })

  it('does not let a reader delete', async () => {
    await writer().put('g_midori/messages/m_2.enc', utf8('x'))
    await expect(reader().delete('g_midori/messages/m_2.enc')).rejects.toThrow()
    await writer().delete('g_midori/messages/m_2.enc')
    await expect(reader().get('g_midori/messages/m_2.enc')).rejects.toThrow(NotFoundError)
  })
})
