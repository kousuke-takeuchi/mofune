import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  PushError,
  buildPushRegistration,
  parsePushRegistration,
  checkFunction,
  notifyScopes,
  pushRegistryFrom,
  replaceRegistry,
} from '../../src/notify/push'
import type { Session } from '../../src/group/session'

function session(): Session {
  return {
    groupId: 'g_midori',
    groupName: 'みどり台',
    userId: 'u_sato',
    displayName: '佐藤 さくら',
    role: 'member',
    scopes: ['all', 'sg_a'],
    groupKeys: new Map(),
    generation: 1,
    roster: { groupId: 'g_midori', generation: 1, subgroups: [], members: [] },
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  } as unknown as Session
}

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'p', auth: 'a' },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildPushRegistration', () => {
  it('carries who subscribed and which scopes they should be woken for', () => {
    const registration = buildPushRegistration({
      session: session(),
      subscription,
      now: new Date('2026-08-08T00:00:00.000Z'),
    })
    expect(registration.userId).toBe('u_sato')
    expect(registration.scopes).toEqual(['all', 'sg_a'])
    expect(registration.subscription.endpoint).toBe(subscription.endpoint)
  })

  it('survives a round trip through the inbox', () => {
    const registration = buildPushRegistration({ session: session(), subscription })
    const bytes = new TextEncoder().encode(JSON.stringify(registration))
    expect(parsePushRegistration(bytes as never)).toEqual(registration)
  })

  it('refuses something that is not a registration', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ hello: 'world' }))
    expect(() => parsePushRegistration(bytes as never)).toThrow(PushError)
  })
})

describe('pushRegistryFrom', () => {
  it('groups the subscriptions by scope, because that is what the function looks up', () => {
    const registry = pushRegistryFrom([
      buildPushRegistration({ session: session(), subscription }),
      buildPushRegistration({
        session: { ...session(), userId: 'u_mori', scopes: ['all'] } as Session,
        subscription: { endpoint: 'https://push.invalid/mori' },
      }),
    ])
    expect(registry.all.map((item) => item.endpoint)).toEqual([
      subscription.endpoint,
      'https://push.invalid/mori',
    ])
    // 誰の購読かを持たせる。送れた人をメールから外すため
    expect(registry.all.map((item) => item.userId)).toEqual(['u_sato', 'u_mori'])
    expect(registry.sg_a.map((item) => item.endpoint)).toEqual([subscription.endpoint])
  })

  it('keeps only the newest subscription of one person', () => {
    const older = buildPushRegistration({
      session: session(),
      subscription: { endpoint: 'https://push.invalid/old' },
      now: new Date('2026-08-01T00:00:00.000Z'),
    })
    const newer = buildPushRegistration({
      session: session(),
      subscription: { endpoint: 'https://push.invalid/new' },
      now: new Date('2026-08-08T00:00:00.000Z'),
    })
    const registry = pushRegistryFrom([newer, older])
    expect(registry.all.map((item) => item.endpoint)).toEqual(['https://push.invalid/new'])
  })
})

describe('checkFunction', () => {
  it('reports the function as usable and hands back the public key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, vapidPublicKey: 'BPUB' })),
    )
    expect(await checkFunction('https://push.invalid')).toEqual({
      ok: true,
      vapidPublicKey: 'BPUB',
    })
  })

  it('says no rather than throwing when the function is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('failed to fetch')
      }),
    )
    expect(await checkFunction('https://push.invalid')).toEqual({ ok: false })
  })

  it('says no when the function answers with an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })))
    expect(await checkFunction('https://push.invalid')).toEqual({ ok: false })
  })

  it('gives up quickly, because posting must not wait on it', async () => {
    const slow = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    vi.stubGlobal('fetch', slow)
    vi.useFakeTimers()
    const pending = checkFunction('https://push.invalid', { timeoutMs: 2000 })
    await vi.advanceTimersByTimeAsync(2100)
    expect(await pending).toEqual({ ok: false })
    vi.useRealTimers()
  })
})

describe('notifyScopes', () => {
  it('asks the function to wake each scope once', async () => {
    const calls = vi.fn(async () => Response.json({ sent: 2, gone: 0, notified: ['u_sato'] }))
    vi.stubGlobal('fetch', calls)

    const result = await notifyScopes({
      functionUrl: 'https://push.invalid/',
      token: 'secret',
      groupId: 'g_midori',
      scopes: ['all', 'sg_a'],
    })

    // 同じ人が2つのスコープに居ても、メールから外すのは1回
    expect(result).toEqual({ sent: 4, failed: 0, notified: ['u_sato'] })
    expect(calls).toHaveBeenCalledTimes(2)
    const [url, init] = calls.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://push.invalid/notify')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret')
    expect(JSON.parse(init.body as string)).toEqual({ group_id: 'g_midori', scope_id: 'all' })
  })

  it('counts a scope that could not be notified instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    )
    expect(
      await notifyScopes({
        functionUrl: 'https://push.invalid',
        token: 'wrong',
        groupId: 'g_midori',
        scopes: ['all'],
      }),
    ).toEqual({ sent: 0, failed: 1, notified: [] })
  })
})

describe('talking to an Apps Script deployment', () => {
  const gas = 'https://script.google.com/macros/s/AKfycbx/exec'

  it('asks for health through a query, because /exec has no sub-paths', async () => {
    const calls = vi.fn(async () => Response.json({ ok: true, vapidPublicKey: 'BPUB' }))
    vi.stubGlobal('fetch', calls)

    await checkFunction(gas)

    const [url] = calls.mock.calls[0] as unknown as [string]
    expect(url).toBe(`${gas}?path=%2Fhealth`)
  })

  it('sends the secret in the body as a plain request, because a preflight would fail', async () => {
    const calls = vi.fn(async () => Response.json({ sent: 1, gone: 0, notified: ['u_sato'] }))
    vi.stubGlobal('fetch', calls)

    await notifyScopes({ functionUrl: gas, token: 'secret', groupId: 'g_midori', scopes: ['all'] })

    const [url, init] = calls.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${gas}?path=%2Fnotify`)
    const headers = init.headers as Record<string, string>
    // 独自ヘッダを付けると preflight が走り、Apps Script はそれに答えない
    expect(headers.authorization).toBeUndefined()
    expect(headers['content-type']).toBe('text/plain;charset=utf-8')
    expect(JSON.parse(init.body as string)).toEqual({
      group_id: 'g_midori',
      scope_id: 'all',
      token: 'secret',
    })
  })

  it('still uses a header and a real path for anything else', async () => {
    const calls = vi.fn(async () => Response.json({ sent: 0, gone: 0, notified: [] }))
    vi.stubGlobal('fetch', calls)

    await notifyScopes({
      functionUrl: 'https://push.invalid',
      token: 'secret',
      groupId: 'g_midori',
      scopes: ['all'],
    })

    const [url, init] = calls.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://push.invalid/notify')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret')
  })
})

describe('a function that cannot set a status code (Apps Script)', () => {
  const gas = 'https://script.google.com/macros/s/AKfycbx/exec'

  it('treats an error in the body as a failure when handing over the registry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unauthorized' })))
    await expect(
      replaceRegistry({ functionUrl: gas, token: 'wrong', groupId: 'g_midori', registry: {} }),
    ).rejects.toThrow()
  })

  it('counts a notify that answered with an error, rather than calling it sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unauthorized' })))
    expect(
      await notifyScopes({ functionUrl: gas, token: 'wrong', groupId: 'g_midori', scopes: ['all'] }),
    ).toEqual({ sent: 0, failed: 1, notified: [] })
  })
})
