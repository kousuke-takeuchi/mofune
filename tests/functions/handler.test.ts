import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handle } from '../../functions/workers/src/handler'
import type { Env, KeyValueStore } from '../../functions/workers/src/handler'
import { generateVapidKeys } from '../../functions/workers/src/vapid'

/** Workers KV の代わり。値は文字列で持つ。 */
function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    async get(key) {
      return data.get(key) ?? null
    },
    async put(key, value) {
      data.set(key, value)
    },
  }
}

let env: Env
let store: ReturnType<typeof memoryStore>

beforeEach(async () => {
  store = memoryStore()
  env = {
    MOFUNE: store,
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    VAPID_SUBJECT: 'mailto:admin@example.invalid',
    // グループごとの共有トークン。手で入れる想定
    TOKENS: JSON.stringify({ g_midori: 'token-midori', g_other: 'token-other' }),
  }
  const keys = await generateVapidKeys()
  env.VAPID_PUBLIC_KEY = keys.publicKey
  env.VAPID_PRIVATE_KEY = keys.privateKey
})

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://push.invalid${path}`, init)
}

function authorized(path: string, body: unknown, token = 'token-midori'): Request {
  return request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: { p256dh: 'p', auth: 'a' },
}

describe('GET /health', () => {
  it('answers without a token, because the caller has not logged in yet', async () => {
    const response = await handle(request('/health'), env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, vapidPublicKey: env.VAPID_PUBLIC_KEY })
  })
})

describe('POST /subscriptions', () => {
  it('replaces the registry for one group', async () => {
    const response = await handle(
      authorized('/subscriptions', {
        group_id: 'g_midori',
        registry: { all: [subscription] },
      }),
      env,
    )
    expect(response.status).toBe(200)
    expect(JSON.parse(store.data.get('registry:g_midori') as string)).toEqual({
      all: [subscription],
    })
  })

  it('refuses a token that belongs to another group', async () => {
    const response = await handle(
      authorized('/subscriptions', { group_id: 'g_midori', registry: {} }, 'token-other'),
      env,
    )
    expect(response.status).toBe(401)
    expect(store.data.size).toBe(0)
  })

  it('refuses a group it has never heard of', async () => {
    const response = await handle(
      authorized('/subscriptions', { group_id: 'g_ghost', registry: {} }, 'token-midori'),
      env,
    )
    expect(response.status).toBe(401)
  })

  it('refuses a registry that is not shaped like one', async () => {
    const response = await handle(
      authorized('/subscriptions', { group_id: 'g_midori', registry: { all: ['nope'] } }),
      env,
    )
    expect(response.status).toBe(400)
    expect(store.data.size).toBe(0)
  })
})

describe('POST /notify', () => {
  beforeEach(() => {
    store.data.set(
      'registry:g_midori',
      JSON.stringify({
        all: [subscription],
        sg_a: [{ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/xyz' }],
      }),
    )
  })

  it('posts an empty push to everyone in the scope', async () => {
    const sent = vi.fn(async () => new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', sent)

    const response = await handle(authorized('/notify', { group_id: 'g_midori', scope_id: 'all' }), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sent: 1, gone: 0 })
    expect(sent).toHaveBeenCalledTimes(1)
    const [url, init] = sent.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(subscription.endpoint)
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
    expect((init.headers as Record<string, string>).Authorization.startsWith('vapid t=')).toBe(true)
    vi.unstubAllGlobals()
  })

  it('drops subscriptions the push service says are gone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 410 })))

    const response = await handle(authorized('/notify', { group_id: 'g_midori', scope_id: 'all' }), env)

    expect(await response.json()).toEqual({ sent: 0, gone: 1 })
    // 消えた購読は名簿から外す。次から無駄に叩かない
    expect(JSON.parse(store.data.get('registry:g_midori') as string).all).toEqual([])
    vi.unstubAllGlobals()
  })

  it('says nothing was sent when the scope has no subscribers', async () => {
    const sent = vi.fn()
    vi.stubGlobal('fetch', sent)
    const response = await handle(
      authorized('/notify', { group_id: 'g_midori', scope_id: 'sg_none' }),
      env,
    )
    expect(await response.json()).toEqual({ sent: 0, gone: 0 })
    expect(sent).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('refuses without a token', async () => {
    const response = await handle(
      request('/notify', { method: 'POST', body: JSON.stringify({ group_id: 'g_midori' }) }),
      env,
    )
    expect(response.status).toBe(401)
  })
})

describe('anything else', () => {
  it('is not found', async () => {
    expect((await handle(request('/'), env)).status).toBe(404)
  })
})
