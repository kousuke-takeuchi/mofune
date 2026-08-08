/**
 * push で起こされたときに出す通知。
 *
 * push そのものは無内容で、本文はここでも出さない。通知は端末の画面に
 * そのまま並ぶ平文の経路なので、伝えるのは「新しい連絡がある」ことだけにする
 * (要件書 §4.5)。中身は本人がアプリを開いて、端末の中で鍵を外して読む。
 */

export interface NotificationContent {
  title: string
  options: {
    body: string
    tag: string
    renotify: boolean
    icon: string
    badge: string
  }
}

export function notificationContent(): NotificationContent {
  return {
    title: 'Mofune',
    options: {
      body: '新しい連絡があります',
      // 同じ tag でまとめる。連投されても通知欄が埋まらない
      tag: 'mofune-new',
      // まとめたうえで、新しいものが来たことは知らせる
      renotify: true,
      icon: './icon-192.png',
      badge: './icon-192.png',
    },
  }
}

interface WindowLike {
  url: string
  focus: () => unknown
}

/** すでにアプリが開いている窓があればそれを使う。無ければ null (新しく開く)。 */
export function chooseClient<T extends WindowLike>(clients: T[], appUrl: string): T | null {
  return clients.find((client) => client.url.startsWith(appUrl)) ?? null
}
