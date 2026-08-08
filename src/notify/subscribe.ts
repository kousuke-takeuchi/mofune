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

interface PushCapableManager {
  subscribe: (options: {
    userVisibleOnly: boolean
    applicationServerKey: Uint8Array
  }) => Promise<{ toJSON: () => unknown }>
  getSubscription: () => Promise<{ unsubscribe: () => Promise<boolean> } | null>
}

async function pushManager(): Promise<PushCapableManager> {
  const worker = (navigator as Navigator & { serviceWorker?: { ready: Promise<unknown> } })
    .serviceWorker
  if (!worker) {
    throw new SubscribeError('このブラウザでは通知を受け取れません')
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
}): Promise<PushSubscriptionRecord> {
  const notification = (globalThis as { Notification?: typeof Notification }).Notification
  if (!notification) {
    throw new SubscribeError('このブラウザでは通知を受け取れません')
  }

  const permission =
    notification.permission === 'granted'
      ? 'granted'
      : await notification.requestPermission()
  if (permission !== 'granted') {
    throw new SubscribeError(
      '通知が許可されていません。端末の設定から Mofune の通知を許可してください',
    )
  }

  const manager = await pushManager()
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
