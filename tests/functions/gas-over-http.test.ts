import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
// @ts-expect-error GAS へそのまま貼る素の JS。型宣言は持たせない
import { handleRequest } from '../../functions/gas/logic.js'
import { checkFunction, notifyScopes, replaceRegistry } from '../../src/notify/push'

/**
 * Apps Script の癖をそのまま真似たサーバーを立て、アプリ側のクライアントで叩く。
 *
 * - 行き先は `?path=` でしか渡せない
 * - 独自ヘッダは preflight を呼ぶので使えない (合言葉は本文)
 * - 応答の状態コードを選べない。断るときも 200 で `{error}` を返す
 *
 * この3つを取り違えると、本番の Apps Script でだけ落ちる。
 */

let server: Server
let origin: string
const data = new Map<string, string>()
const pushed: string[] = []

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
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
      const result = handleRequest(
        {
          path: url.searchParams.get('path') ?? '/',
          method: request.method,
          body,
          // Apps Script はヘッダを渡してこない
          authorization: '',
        },
        {
          store: {
            get: (key: string) => data.get(key) ?? null,
            put: (key: string, value: string) => void data.set(key, value),
          },
          tokens: { g_midori: 'shared-secret' },
          vapidPublicKey: 'BPUB',
          sendPush: (endpoint: string) => {
            pushed.push(endpoint)
            return 201
          },
        },
      )
      // どんな結果でも 200 で返すのが Apps Script
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(result.body))
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

describe('the GAS deployment, called by the app', () => {
  it('answers the health check', async () => {
    expect(await checkFunction(origin)).toEqual({ ok: true, vapidPublicKey: 'BPUB' })
  })

  it('takes the registry and wakes it', async () => {
    await replaceRegistry({
      functionUrl: origin,
      token: 'shared-secret',
      groupId: 'g_midori',
      registry: { all: [{ endpoint: 'https://push.invalid/sato', userId: 'u_sato' }] },
    })

    expect(
      await notifyScopes({
        functionUrl: origin,
        token: 'shared-secret',
        groupId: 'g_midori',
        scopes: ['all'],
      }),
    ).toEqual({ sent: 1, failed: 0, notified: ['u_sato'] })
    expect(pushed).toEqual(['https://push.invalid/sato'])
  })

  it('is not fooled by a 200 that carries a refusal', async () => {
    await expect(
      replaceRegistry({
        functionUrl: origin,
        token: 'wrong',
        groupId: 'g_midori',
        registry: {},
      }),
    ).rejects.toThrow()
  })
})
