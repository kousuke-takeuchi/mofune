import type { PushSubscriptionRecord } from './push'

export class SubscribeError extends Error {}

/**
 * base64url の VAPID 公開鍵を、`pushManager.subscribe` が受け取るバイト列にする。
 * 文字列のまま渡せるブラウザもあるが、渡せないものがあるので必ず変換する。
 */
export function applicationServerKey(publicKey: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(publicKey)) {
    throw new SubscribeError('通知の鍵を読み取れませんでした')
  }
  const padded = publicKey.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/** 待っても返ってこない相手に、いつまでも付き合わない。 */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SubscribeError(message)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (cause: unknown) => {
        clearTimeout(timer)
        reject(cause instanceof Error ? cause : new SubscribeError(String(cause)))
      },
    )
  })
}

interface PushCapableManager {
  subscribe: (options: {
    userVisibleOnly: boolean
    applicationServerKey: Uint8Array
  }) => Promise<{ toJSON: () => unknown }>
  getSubscription: () => Promise<{ unsubscribe: () => Promise<boolean> } | null>
}

async function pushManager(): Promise<PushCapableManager> {
  const worker = (
    navigator as Navigator & {
      serviceWorker?: {
        ready: Promise<unknown>
        getRegistration?: () => Promise<unknown>
      }
    }
  ).serviceWorker
  if (!worker) {
    throw new SubscribeError('このブラウザでは通知を受け取れません')
  }
  // 登録が無いと ready は永久に解決しない。先に有無を確かめる
  if (worker.getRegistration && !(await worker.getRegistration())) {
    throw new SubscribeError(
      'この端末ではまだアプリが登録されていません。ホーム画面に追加してから、もう一度お試しください',
    )
  }
  const registration = (await worker.ready) as { pushManager?: PushCapableManager }
  if (!registration.pushManager) {
    throw new SubscribeError('このブラウザでは通知を受け取れません')
  }
  return registration.pushManager
}

/**
 * この端末で通知を受け取れるようにする。
 *
 * iOS はホーム画面に追加していないと購読できない。断られたら、そのことを
 * そのまま伝えて終わる (勝手に何度も訊かない)。
 */
export async function subscribeThisDevice(options: {
  vapidPublicKey: string
  /** 許可の応答が返らない環境があるので、待つ時間に上限を置く。 */
  timeoutMs?: number
}): Promise<PushSubscriptionRecord> {
  const notification = (globalThis as { Notification?: typeof Notification }).Notification
  if (!notification) {
    throw new SubscribeError('このブラウザでは通知を受け取れません')
  }

  // 先に受け皿を確かめる。無いまま許可だけ求めても、答えを活かせない
  const manager = await pushManager()

  const permission =
    notification.permission === 'granted'
      ? 'granted'
      : await withTimeout(
          Promise.resolve(notification.requestPermission()),
          options.timeoutMs ?? 60_000,
          '通知の許可を確認できませんでした。端末の設定から Mofune の通知を許可してください',
        )
  if (permission !== 'granted') {
    throw new SubscribeError(
      '通知が許可されていません。端末の設定から Mofune の通知を許可してください',
    )
  }
  const subscription = await manager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(options.vapidPublicKey),
  })
  const record = subscription.toJSON() as PushSubscriptionRecord
  if (typeof record.endpoint !== 'string' || record.endpoint === '') {
    throw new SubscribeError('この端末では通知の購読を作れませんでした')
  }
  return record
}

/** この端末の購読をやめる。関数側の名簿からは、次の回収のときに落ちる。 */
export async function unsubscribeThisDevice(): Promise<void> {
  const manager = await pushManager()
  const current = await manager.getSubscription()
  if (current) await current.unsubscribe()
}
