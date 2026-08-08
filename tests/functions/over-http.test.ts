import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { handle } from '../../functions/workers/src/handler'
import type { Env, KeyValueStore } from '../../functions/workers/src/handler'
import { generateVapidKeys, vapidAudience } from '../../functions/workers/src/vapid'
import { checkFunction, notifyScopes, replaceRegistry } from '../../src/notify/push'

/**
 * 関数を素の HTTP で動かし、アプリ側のクライアントから本当に叩く。
 *
 * 単体テストでは fetch を差し替えているので、ヘッダの綴りやメソッドの取り違えは
 * 見つからない。ここは本物の Request / Response を通す。
 * push サービスの代わりも自前の HTTP サーバーで受け、VAPID ヘッダを検査する。
 */

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>()
  return {
    async get(key) {
      return data.get(key) ?? null
    },
    async put(key, value) {
      data.set(key, value)
    },
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, origin: `http://127.0.0.1:${port}` })
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

let functionServer: Server
let functionOrigin: string
let pushServer: Server
let pushOrigin: string
const received: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = []
let env: Env

beforeAll(async () => {
  const keys = await generateVapidKeys()
  env = {
    MOFUNE: memoryStore(),
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
    VAPID_SUBJECT: 'mailto:admin@example.invalid',
    TOKENS: JSON.stringify({ g_midori: 'shared-secret' }),
  }

  // push サービスの代役。届いたヘッダを控えるだけ
  const push = await listen((request, response) => {
    received.push({ url: request.url ?? '', headers: request.headers })
    response.writeHead(201).end()
  })
  pushServer = push.server
  pushOrigin = push.origin

  const fn = await listen((request, response) => {
    void (async () => {
      const body = await readBody(request)
      const worker = new Request(`http://127.0.0.1${request.url ?? '/'}`, {
        method: request.method,
        headers: request.headers as Record<string, string>,
        ...(body === '' ? {} : { body }),
      })
      const result = await handle(worker, env)
      const text = await result.text()
      response.writeHead(result.status, Object.fromEntries(result.headers.entries())).end(text)
    })()
  })
  functionServer = fn.server
  functionOrigin = fn.origin
})

afterAll(async () => {
  await close(functionServer)
  await close(pushServer)
})

describe('the function over real HTTP', () => {
  it('answers a health check from the app client', async () => {
    const health = await checkFunction(functionOrigin)
    expect(health.ok).toBe(true)
    expect(health.vapidPublicKey).toBe(env.VAPID_PUBLIC_KEY)
  })

  it('takes a registry and then wakes it, signing each push', async () => {
    await replaceRegistry({
      functionUrl: functionOrigin,
      token: 'shared-secret',
      groupId: 'g_midori',
      registry: {
        all: [{ endpoint: `${pushOrigin}/push/sato`, userId: 'u_sato' }],
      },
    })

    const result = await notifyScopes({
      functionUrl: functionOrigin,
      token: 'shared-secret',
      groupId: 'g_midori',
      scopes: ['all'],
    })

    expect(result).toEqual({ sent: 1, failed: 0, notified: ['u_sato'] })
    expect(received).toHaveLength(1)
    const headers = received[0]?.headers ?? {}
    expect(String(headers.authorization)).toContain('vapid t=')
    expect(String(headers.authorization)).toContain(`k=${env.VAPID_PUBLIC_KEY}`)
    expect(headers.ttl).toBe('86400')
    // 中身は送らない
    expect(headers['content-length']).toBe('0')

    // 署名の相手は購読ごとの URL ではなく push サービスのオリジン
    const token = String(headers.authorization).slice('vapid t='.length).split(',')[0] as string
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] as string, 'base64url').toString('utf8'),
    ) as { aud: string }
    expect(claims.aud).toBe(vapidAudience(`${pushOrigin}/push/sato`))
  })

  it('turns away a wrong secret over the wire too', async () => {
    await expect(
      replaceRegistry({
        functionUrl: functionOrigin,
        token: 'wrong',
        groupId: 'g_midori',
        registry: {},
      }),
    ).rejects.toThrow()
  })
})
