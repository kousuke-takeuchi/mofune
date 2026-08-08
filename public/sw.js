/*
 * アプリの殻をキャッシュして、圏外でも開けるようにする。
 *
 * 持つのは殻だけ。保管場所のデータは触らない。持つと端末に中身が増えるうえ、
 * 古いものを配ってしまう。お知らせの控えは IndexedDB が受け持つ。
 *
 * キャッシュ名に版を持たせ、activate で古い版を捨てる。捨てないと、直した
 * はずの不具合が残り続ける端末ができる。
 */
const VERSION = 'v1'
const SHELL = `mofune-shell-${VERSION}`
const BASE = new URL('./', self.location.href)

/** src/sw/cache-policy.ts と同じ判断。片方だけ直さないこと。 */
function belongsToShell(url) {
  let target
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (target.origin !== BASE.origin) return false
  if (target.pathname.startsWith('/fonts/')) return true
  return target.pathname.startsWith(BASE.pathname)
}

self.addEventListener('install', (event) => {
  // 最低限、入口だけは先に持っておく。残りは使われた順に溜まる。
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(['./', './manifest.webmanifest'])),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== SHELL).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  if (!belongsToShell(request.url)) return

  // 画面遷移はネットワーク優先。新しい版が出ていたらすぐ乗り換えたい。
  // 圏外のときだけ控えを出す。
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(SHELL).then((cache) => cache.put('./', copy))
          return response
        })
        .catch(() => caches.match('./').then((hit) => hit ?? Response.error())),
    )
    return
  }

  // 中身がハッシュ付きの資産はキャッシュ優先でよい。名前が変われば別物になる。
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(SHELL).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})
