import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  SubscribeError,
  applicationServerKey,
  subscribeThisDevice,
} from '../../src/notify/subscribe'

/** 形だけ正しい鍵。中身の妥当性はブラウザが見る。 */
const VALID_KEY = `BA${'A'.repeat(85)}`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('applicationServerKey', () => {
  it('turns the base64url public key into the bytes the browser wants', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
    ])
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const publicKey = btoa(String.fromCharCode(...raw))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    const key = applicationServerKey(publicKey)
    expect(key).toBeInstanceOf(Uint8Array)
    // 65バイトの非圧縮点。頭は必ず 0x04
    expect(key.length).toBe(65)
    expect(key[0]).toBe(4)
  })

  it('refuses a key that is not base64url', () => {
    expect(() => applicationServerKey('not a key!!')).toThrow(SubscribeError)
  })
})

describe('subscribeThisDevice', () => {
  function browser(options: { permission: NotificationPermission; subscription?: unknown }) {
    const subscribe = vi.fn(async () => ({
      toJSON: () => options.subscription ?? { endpoint: 'https://push.invalid/abc', keys: {} },
    }))
    vi.stubGlobal('Notification', {
      permission: options.permission,
      requestPermission: vi.fn(async () => options.permission),
    })
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: { subscribe, getSubscription: vi.fn(async () => null) },
        }),
      },
    })
    return subscribe
  }

  it('asks the browser to subscribe with the key the function handed out', async () => {
    const subscribe = browser({ permission: 'granted' })

    const record = await subscribeThisDevice({ vapidPublicKey: VALID_KEY })

    expect(record.endpoint).toBe('https://push.invalid/abc')
    const [passed] = subscribe.mock.calls[0] as unknown as [PushSubscriptionOptionsInit]
    expect(passed.userVisibleOnly).toBe(true)
    expect(passed.applicationServerKey).toBeInstanceOf(Uint8Array)
  })

  it('explains a refusal instead of failing silently', async () => {
    browser({ permission: 'denied' })
    await expect(subscribeThisDevice({ vapidPublicKey: VALID_KEY })).rejects.toThrow(
      SubscribeError,
    )
  })

  it('says so when the browser has no push at all', async () => {
    vi.stubGlobal('Notification', undefined)
    vi.stubGlobal('navigator', {})
    await expect(subscribeThisDevice({ vapidPublicKey: VALID_KEY })).rejects.toThrow(
      SubscribeError,
    )
  })
})

describe('when the browser never answers', () => {
  it('gives up on the permission prompt instead of hanging forever', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      // 応答が返らない環境がある (プロンプトが出ない・閉じられた)
      requestPermission: () => new Promise<NotificationPermission>(() => {}),
    })
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: async () => ({}),
        ready: Promise.resolve({ pushManager: { subscribe: async () => ({ toJSON: () => ({}) }) } }),
      },
    })
    vi.useFakeTimers()
    const pending = subscribeThisDevice({ vapidPublicKey: VALID_KEY, timeoutMs: 20_000 })
    const assertion = expect(pending).rejects.toThrow(SubscribeError)
    await vi.advanceTimersByTimeAsync(20_100)
    await assertion
    vi.useRealTimers()
  })

  it('says to add the app to the home screen when no service worker is registered', async () => {
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' })
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: async () => undefined,
        // 登録が無いと ready は永久に解決しない。触らせない
        ready: new Promise(() => {}),
      },
    })
    await expect(subscribeThisDevice({ vapidPublicKey: VALID_KEY })).rejects.toThrow(SubscribeError)
  })
})
