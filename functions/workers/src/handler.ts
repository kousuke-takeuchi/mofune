import { buildVapidHeaders } from './vapid'

/**
 * 関数層 (設計書 §10)。持つ状態は購読名簿と VAPID 鍵だけで、どちらも
 * 管理者の端末から入れ直せる。本文の鍵には一切触れない。
 */

export interface KeyValueStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

export interface Env {
  MOFUNE: KeyValueStore
  VAPID_PUBLIC_KEY: string
  VAPID_PRIVATE_KEY: string
  VAPID_SUBJECT: string
  /** {"g_xxx": "トークン"} の JSON。グループごとに別のトークンを配る。 */
  TOKENS: string
}

export interface PushSubscriptionRecord {
  endpoint: string
  keys?: { p256dh: string; auth: string }
}

/** スコープ -> 購読の束。関数は所属も名簿も知らない。 */
export type Registry = Record<string, PushSubscriptionRecord[]>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  })
}

/** 早く返るかどうかでトークンを当てられないようにする。 */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function authorize(request: Request, env: Env, groupId: unknown): groupId is string {
  if (typeof groupId !== 'string' || groupId === '') return false
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return false
  let tokens: Record<string, string>
  try {
    tokens = JSON.parse(env.TOKENS) as Record<string, string>
  } catch {
    return false
  }
  const expected = tokens[groupId]
  if (typeof expected !== 'string') return false
  return sameSecret(header.slice('Bearer '.length), expected)
}

function isRegistry(value: unknown): value is Registry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(
    (list) =>
      Array.isArray(list) &&
      list.every(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          typeof (item as PushSubscriptionRecord).endpoint === 'string',
      ),
  )
}

function registryKey(groupId: string): string {
  return `registry:${groupId}`
}

async function readRegistry(env: Env, groupId: string): Promise<Registry> {
  const stored = await env.MOFUNE.get(registryKey(groupId))
  if (!stored) return {}
  try {
    const parsed: unknown = JSON.parse(stored)
    return isRegistry(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json()
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url)

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      },
    })
  }

  // 生きているかは誰でも訊ける。ここで公開鍵も配り、購読を作る側が使う
  if (pathname === '/health' && request.method === 'GET') {
    return json({ ok: true, vapidPublicKey: env.VAPID_PUBLIC_KEY })
  }

  if (pathname === '/subscriptions' && request.method === 'POST') {
    const payload = await body(request)
    if (!authorize(request, env, payload.group_id)) return json({ error: 'unauthorized' }, 401)
    if (!isRegistry(payload.registry)) return json({ error: 'bad registry' }, 400)
    await env.MOFUNE.put(registryKey(payload.group_id), JSON.stringify(payload.registry))
    return json({ ok: true })
  }

  if (pathname === '/notify' && request.method === 'POST') {
    const payload = await body(request)
    if (!authorize(request, env, payload.group_id)) return json({ error: 'unauthorized' }, 401)
    const scopeId = typeof payload.scope_id === 'string' ? payload.scope_id : ''

    const registry = await readRegistry(env, payload.group_id)
    const targets = registry[scopeId] ?? []

    let sent = 0
    const gone: string[] = []
    for (const target of targets) {
      const headers = await buildVapidHeaders({
        endpoint: target.endpoint,
        subject: env.VAPID_SUBJECT,
        keys: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
      })
      // 中身は送らない。端末は起こされてから自分で取りに行く
      const response = await fetch(target.endpoint, { method: 'POST', headers })
      if (response.status === 404 || response.status === 410) {
        gone.push(target.endpoint)
      } else if (response.ok) {
        sent += 1
      }
    }

    if (gone.length > 0) {
      registry[scopeId] = targets.filter((target) => !gone.includes(target.endpoint))
      await env.MOFUNE.put(registryKey(payload.group_id), JSON.stringify(registry))
    }

    return json({ sent, gone: gone.length })
  }

  return json({ error: 'not found' }, 404)
}
