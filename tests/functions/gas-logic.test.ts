// @ts-expect-error GAS へそのまま貼る素の JS。型宣言は持たせない
import { handleRequest } from '../../functions/gas/logic.js'
import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * GAS 版は Workers 版と同じ HTTP 契約でなければならない (設計書 §10.1)。
 * 中身の書き方は違っても、外から見た振る舞いは同じであることをここで縛る。
 */

interface Deps {
  store: { get: (key: string) => string | null; put: (key: string, value: string) => void }
  tokens: Record<string, string>
  vapidPublicKey: string
  sendPush: (endpoint: string) => number
}

let data: Map<string, string>
let deps: Deps
let sent: string[]

beforeEach(() => {
  data = new Map()
  sent = []
  deps = {
    store: {
      get: (key) => data.get(key) ?? null,
      put: (key, value) => void data.set(key, value),
    },
    tokens: { g_midori: 'token-midori', g_other: 'token-other' },
    vapidPublicKey: 'BPUB',
    sendPush: (endpoint) => {
      sent.push(endpoint)
      return 201
    },
  }
})

function post(path: string, body: unknown, token?: string) {
  return handleRequest(
    {
      path,
      method: 'POST',
      body,
      authorization: token === undefined ? '' : `Bearer ${token}`,
    },
    deps,
  )
}

const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', userId: 'u_sato' }

describe('GET /health', () => {
  it('answers without a token and hands out the public key', () => {
    const result = handleRequest({ path: '/health', method: 'GET', body: null, authorization: '' }, deps)
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, vapidPublicKey: 'BPUB' })
  })
})

describe('POST /subscriptions', () => {
  it('replaces the registry for one group', () => {
    const result = post('/subscriptions', {
      group_id: 'g_midori',
      registry: { all: [subscription] },
    }, 'token-midori')

    expect(result.status).toBe(200)
    expect(JSON.parse(data.get('registry:g_midori') as string)).toEqual({ all: [subscription] })
  })

  it('refuses another group token', () => {
    const result = post('/subscriptions', { group_id: 'g_midori', registry: {} }, 'token-other')
    expect(result.status).toBe(401)
    expect(data.size).toBe(0)
  })

  it('refuses a registry that is not shaped like one', () => {
    const result = post(
      '/subscriptions',
      { group_id: 'g_midori', registry: { all: ['nope'] } },
      'token-midori',
    )
    expect(result.status).toBe(400)
  })
})

describe('POST /notify', () => {
  beforeEach(() => {
    data.set('registry:g_midori', JSON.stringify({ all: [subscription] }))
  })

  it('wakes the scope and reports who was reached', () => {
    const result = post('/notify', { group_id: 'g_midori', scope_id: 'all' }, 'token-midori')
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ sent: 1, gone: 0, notified: ['u_sato'] })
    expect(sent).toEqual([subscription.endpoint])
  })

  it('drops the subscriptions the push service says are gone', () => {
    deps.sendPush = () => 410
    const result = post('/notify', { group_id: 'g_midori', scope_id: 'all' }, 'token-midori')
    expect(result.body).toEqual({ sent: 0, gone: 1, notified: [] })
    expect(JSON.parse(data.get('registry:g_midori') as string).all).toEqual([])
  })

  it('keeps going when one endpoint blows up', () => {
    data.set(
      'registry:g_midori',
      JSON.stringify({
        all: [subscription, { endpoint: 'https://push.invalid/mori', userId: 'u_mori' }],
      }),
    )
    deps.sendPush = vi.fn((endpoint: string) => {
      if (endpoint === subscription.endpoint) throw new Error('network')
      return 201
    })
    const result = post('/notify', { group_id: 'g_midori', scope_id: 'all' }, 'token-midori')
    expect(result.body).toEqual({ sent: 1, gone: 0, notified: ['u_mori'] })
  })

  it('says nothing was sent for a scope with no subscribers', () => {
    const result = post('/notify', { group_id: 'g_midori', scope_id: 'sg_none' }, 'token-midori')
    expect(result.body).toEqual({ sent: 0, gone: 0, notified: [] })
    expect(sent).toEqual([])
  })

  it('refuses without a token', () => {
    expect(post('/notify', { group_id: 'g_midori', scope_id: 'all' }).status).toBe(401)
  })
})

describe('anything else', () => {
  it('is not found', () => {
    expect(
      handleRequest({ path: '/', method: 'GET', body: null, authorization: '' }, deps).status,
    ).toBe(404)
  })
})

describe('the secret arrives in the body, because Apps Script cannot take a header', () => {
  it('accepts it there', () => {
    const result = handleRequest(
      {
        path: '/subscriptions',
        method: 'POST',
        body: { group_id: 'g_midori', registry: {}, token: 'token-midori' },
        authorization: '',
      },
      deps,
    )
    expect(result.status).toBe(200)
  })

  it('still refuses a wrong one', () => {
    const result = handleRequest(
      {
        path: '/notify',
        method: 'POST',
        body: { group_id: 'g_midori', scope_id: 'all', token: 'nope' },
        authorization: '',
      },
      deps,
    )
    expect(result.status).toBe(401)
  })

  it('never writes the secret into the registry it stores', () => {
    handleRequest(
      {
        path: '/subscriptions',
        method: 'POST',
        body: {
          group_id: 'g_midori',
          registry: { all: [subscription] },
          token: 'token-midori',
        },
        authorization: '',
      },
      deps,
    )
    expect(data.get('registry:g_midori')).not.toContain('token-midori')
  })
})
