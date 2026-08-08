import type { Bytes } from '../crypto/bytes'
import { fromUtf8 } from '../crypto/bytes'
import type { Session } from '../group/session'

export class PushError extends Error {}

export const PUSH_REGISTRATION_VERSION = 1

/** 参加者の端末が作る購読。中身は push サービスの宛先だけ。 */
export interface PushSubscriptionRecord {
  endpoint: string
  /** 誰の購読か。関数はこれをそのまま返し、投稿側がメールから外す。 */
  userId?: string
  keys?: { p256dh: string; auth: string }
}

export interface PushRegistration {
  v: number
  kind: 'push-subscription'
  userId: string
  /** この人を起こすべきスコープ。関数は所属を知らないのでここで渡す。 */
  scopes: string[]
  subscription: PushSubscriptionRecord
  at: string
}

/** スコープ -> 購読の束。関数へそのまま渡す形。 */
export type PushRegistry = Record<string, PushSubscriptionRecord[]>

export function buildPushRegistration(options: {
  session: Session
  subscription: PushSubscriptionRecord
  now?: Date
}): PushRegistration {
  if (typeof options.subscription.endpoint !== 'string' || options.subscription.endpoint === '') {
    throw new PushError('この端末では通知の購読を作れませんでした')
  }
  return {
    v: PUSH_REGISTRATION_VERSION,
    kind: 'push-subscription',
    userId: options.session.userId,
    scopes: [...options.session.scopes],
    subscription: options.subscription,
    at: (options.now ?? new Date()).toISOString(),
  }
}

export function parsePushRegistration(bytes: Bytes): PushRegistration {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new PushError('push registration is not valid JSON')
  }
  const registration = parsed as PushRegistration
  if (
    registration === null ||
    typeof registration !== 'object' ||
    registration.v !== PUSH_REGISTRATION_VERSION ||
    registration.kind !== 'push-subscription' ||
    typeof registration.userId !== 'string' ||
    !Array.isArray(registration.scopes) ||
    registration.subscription === null ||
    typeof registration.subscription !== 'object' ||
    typeof registration.subscription.endpoint !== 'string'
  ) {
    throw new PushError('push registration is missing required fields')
  }
  return registration
}

/**
 * 集めた購読を、関数が引ける形へ組み替える。
 *
 * 同じ人の古い購読は落とす。端末を替えたり通知を入れ直したりすると新しい
 * 宛先ができるので、残しておくと消えた宛先を叩き続けることになる。
 */
export function pushRegistryFrom(registrations: PushRegistration[]): PushRegistry {
  const newest = new Map<string, PushRegistration>()
  for (const registration of registrations) {
    const current = newest.get(registration.userId)
    if (!current || current.at < registration.at) newest.set(registration.userId, registration)
  }

  const registry: PushRegistry = {}
  for (const registration of newest.values()) {
    for (const scope of registration.scopes) {
      registry[scope] = [
        ...(registry[scope] ?? []),
        { ...registration.subscription, userId: registration.userId },
      ]
    }
  }
  return registry
}

/**
 * Apps Script の web アプリは `/exec` 固定でパスを持てず、preflight にも
 * 答えない。そこで行き先は問い合わせ文字列で渡し、合言葉は本文へ入れて
 * 「素のリクエスト」にする (設計書 §10.2)。
 */
function isAppsScript(functionUrl: string): boolean {
  // 見分けるのはホスト名ではなく配置のかたち。試験用に手元へ立てたものも同じ扱いにする
  return /\/macros\/s\//.test(functionUrl)
}

function endpointOf(functionUrl: string, path: string): string {
  const base = functionUrl.replace(/\/+$/, '')
  return isAppsScript(functionUrl) ? `${base}?path=${encodeURIComponent(path)}` : `${base}${path}`
}

/** 合言葉の渡しかたと本文の作りかたは、相手が Apps Script かどうかで変わる。 */
function callFunction(options: {
  functionUrl: string
  path: string
  token: string
  payload: Record<string, unknown>
}): Promise<Response> {
  const url = endpointOf(options.functionUrl, options.path)
  if (isAppsScript(options.functionUrl)) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...options.payload, token: options.token }),
    })
  }
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(options.payload),
  })
}

/**
 * 関数が使えるかどうか。投稿のたびに叩くので、待たせないことを最優先にする。
 * 落ちていても投稿は止めず、メールへ落とす (設計書 §9.1)。
 */
export async function checkFunction(
  functionUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; vapidPublicKey?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000)
  try {
    const response = await fetch(endpointOf(functionUrl, '/health'), { signal: controller.signal })
    if (!response.ok) return { ok: false }
    const body = (await response.json()) as { ok?: boolean; vapidPublicKey?: string }
    if (body.ok !== true) return { ok: false }
    return typeof body.vapidPublicKey === 'string'
      ? { ok: true, vapidPublicKey: body.vapidPublicKey }
      : { ok: true }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Apps Script は応答の状態コードを選べず、断ったときも 200 で返る。
 * 本文に error があれば失敗として扱う。
 */
async function readResult(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.ok) return null
  try {
    const body = (await response.json()) as Record<string, unknown>
    return typeof body.error === 'string' ? null : body
  } catch {
    return null
  }
}

/** 名簿をまるごと差し替える。関数は差分を持たない。 */
export async function replaceRegistry(options: {
  functionUrl: string
  token: string
  groupId: string
  registry: PushRegistry
}): Promise<void> {
  const response = await callFunction({
    functionUrl: options.functionUrl,
    path: '/subscriptions',
    token: options.token,
    payload: { group_id: options.groupId, registry: options.registry },
  })
  if (!(await readResult(response))) {
    throw new PushError('通知の購読名簿を関数へ渡せませんでした')
  }
}

/** 配信したスコープぶんだけ起こす。失敗しても投稿は成立しているので数えるだけ。 */
export async function notifyScopes(options: {
  functionUrl: string
  token: string
  groupId: string
  scopes: string[]
}): Promise<{ sent: number; failed: number; notified: string[] }> {
  let sent = 0
  let failed = 0
  const notified = new Set<string>()
  for (const scope of options.scopes) {
    try {
      const response = await callFunction({
        functionUrl: options.functionUrl,
        path: '/notify',
        token: options.token,
        payload: { group_id: options.groupId, scope_id: scope },
      })
      const body = (await readResult(response)) as
        | { sent?: number; notified?: string[] }
        | null
      if (!body) {
        failed += 1
        continue
      }
      sent += typeof body.sent === 'number' ? body.sent : 0
      for (const userId of body.notified ?? []) notified.add(userId)
    } catch {
      failed += 1
    }
  }
  return { sent, failed, notified: [...notified] }
}
