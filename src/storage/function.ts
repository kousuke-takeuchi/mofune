import type { Bytes } from '../crypto/bytes'
import { fromBase64, toBase64 } from '../crypto/bytes'
import type { StorageCapabilities, StorageEntry, StorageProvider } from './provider'
import { NotFoundError, UnsupportedOperationError, assertSafePath } from './provider'

/**
 * 関数層そのものを置き場にする経路 (設計書 §10.2)。
 *
 * Apps Script は所有者の権限で動くので、そこから Drive を読み書きすれば、
 * 参加者にも担当者にも OAuth も資格情報も持たせずに済む。読みは誰でもできる
 * (中身は封緘済み)、書きはグループの合言葉、上りは担当者が配る引換券。
 *
 * 公開バケットと違って**一覧が取れる**のがこの経路の利点で、
 * events-index.json に頼らずに差分同期ができる。
 */
export class FunctionStorageProvider implements StorageProvider {
  private readonly functionUrl: string
  private readonly groupId: string
  private readonly token: string | undefined

  constructor(options: { functionUrl: string; groupId: string; token?: string }) {
    this.functionUrl = options.functionUrl.replace(/\/+$/, '')
    this.groupId = options.groupId
    this.token = options.token
  }

  get capabilities(): StorageCapabilities {
    return {
      read: true,
      write: this.token !== undefined,
      list: true,
      // 参加者は引換券で自分の受信箱にだけ書ける
      inbox: true,
    }
  }

  private endpoint(path: string, query: Record<string, string> = {}): string {
    const params = new URLSearchParams({ path, ...query })
    return `${this.functionUrl}?${params.toString()}`
  }

  /**
   * Apps Script は独自ヘッダを受け取れない (preflight に答えられない) ので、
   * 素のリクエストで送り、合言葉は本文へ入れる。状態コードも選べないため、
   * 失敗は本文の error で判断する。
   */
  private async call(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(this.endpoint(path), {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    })
    return this.readBody(response)
  }

  private async readBody(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok) {
      throw new Error(`関数が ${String(response.status)} を返しました`)
    }
    const body = (await response.json()) as Record<string, unknown>
    if (typeof body.error === 'string') {
      if (body.error === 'not found') throw new NotFoundError('no object at this key')
      throw new Error(body.error)
    }
    return body
  }

  async get(path: string): Promise<Bytes> {
    assertSafePath(path)
    const response = await fetch(
      this.endpoint('/object', { group_id: this.groupId, key: path }),
    )
    const body = await this.readBody(response)
    if (typeof body.body !== 'string') {
      throw new NotFoundError(`no object at "${path}"`)
    }
    return fromBase64(body.body)
  }

  async put(path: string, data: Bytes): Promise<void> {
    assertSafePath(path)
    if (this.token === undefined) {
      throw new UnsupportedOperationError('this provider can only read')
    }
    await this.call('/object', {
      group_id: this.groupId,
      key: path,
      body: toBase64(data),
      token: this.token,
    })
  }

  async list(prefix: string, after?: string): Promise<StorageEntry[]> {
    // 絞りは関数側でも行う。全件返してから手元で捨てると往復が太る
    const body = await this.call('/list', {
      group_id: this.groupId,
      prefix,
      ...(after === undefined ? {} : { after }),
    })
    const entries = Array.isArray(body.entries) ? (body.entries as Array<Record<string, unknown>>) : []
    return entries
      .map((entry) => ({
        path: String(entry.key),
        size: typeof entry.size === 'number' ? entry.size : 0,
      }))
      // 差分同期は辞書順に頼る。Drive の返す順は当てにしない
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .filter((entry) => after === undefined || entry.path > after)
  }

  async delete(path: string): Promise<void> {
    assertSafePath(path)
    if (this.token === undefined) {
      throw new UnsupportedOperationError('this provider can only read')
    }
    await this.call('/delete', { group_id: this.groupId, key: path, token: this.token })
  }

  /** 参加者からの投函。合言葉ではなく、担当者が配った引換券で通す。 */
  async submitToInbox(path: string, data: Bytes, ticket: string): Promise<void> {
    assertSafePath(path)
    await this.call('/inbox', {
      group_id: this.groupId,
      key: path,
      body: toBase64(data),
      ticket,
    })
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 投函の引換券。合言葉と置き場所から作るので、担当者は合言葉を渡さずに
 * 「ここへ1つ置いてよい」とだけ伝えられる。関数側は同じ計算で確かめる。
 */
export async function inboxTicket(token: string, key: string): Promise<string> {
  const secret = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    secret,
    new TextEncoder().encode(key) as unknown as ArrayBuffer,
  )
  return toBase64Url(new Uint8Array(signature))
}
