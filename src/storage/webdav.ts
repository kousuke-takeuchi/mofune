import type { Bytes } from '../crypto/bytes'
import type { StorageCapabilities, StorageEntry, StorageProvider } from './provider'
import { NotFoundError, UnsupportedOperationError, assertSafePath } from './provider'

export interface WebdavCredentials {
  username: string
  password: string
}

export interface WebdavConfig {
  /** 共有フォルダの起点。末尾のスラッシュは付けない。 */
  baseUrl: string
  /** 書き込みに使う資格情報。参加者は持たない。 */
  credentials?: WebdavCredentials
}

/**
 * WebDAV (Nextcloud・NAS など) を置き場にする。
 *
 * S3 互換でない置き場でこれが使えるのは、**公開共有の起点にパスを継ぎ足せる**
 * ためで、共有リンクがファイルごとに別 URL になる Dropbox や Box とは違う。
 *
 * presigned URL に当たるものは無いので、参加者からの上りはこのプロバイダでは
 * 扱えない (`capabilities.inbox` は false)。上りが必要なグループは関数層の
 * 引換券を使う (`src/storage/function.ts`)。
 */
export class WebdavStorageProvider implements StorageProvider {
  private readonly baseUrl: string
  private readonly credentials: WebdavCredentials | undefined
  /** 掘ったことのあるフォルダ。同じ階層を何度も作りに行かない。 */
  private readonly known = new Set<string>()

  constructor(config: WebdavConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.credentials = config.credentials
  }

  get capabilities(): StorageCapabilities {
    return {
      read: true,
      write: this.credentials !== undefined,
      list: true,
      // 資格情報なしに1つだけ置ける経路が無い
      inbox: false,
    }
  }

  private urlFor(path: string): string {
    assertSafePath(path)
    return `${this.baseUrl}/${path}`
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    if (!this.credentials) return extra
    const { username, password } = this.credentials
    return { authorization: `Basic ${btoa(`${username}:${password}`)}`, ...extra }
  }

  private requireCredentials(): void {
    if (!this.credentials) {
      throw new UnsupportedOperationError('this provider can only read')
    }
  }

  async get(path: string): Promise<Bytes> {
    const response = await fetch(this.urlFor(path), { headers: this.headers() })
    if (response.status === 404) {
      throw new NotFoundError(`no object at "${path}"`)
    }
    if (!response.ok) {
      throw new Error(`storage request failed with ${String(response.status)} for "${path}"`)
    }
    return new Uint8Array(await response.arrayBuffer()) as Bytes
  }

  /**
   * 親フォルダが無いと WebDAV は PUT を断る。断られたら上から順に掘って
   * 置き直す。先に毎回掘ると、1件置くたびに階層ぶんの往復が増える。
   */
  private async makeFolders(path: string): Promise<void> {
    const parts = path.split('/')
    parts.pop()
    let walked = ''
    for (const part of parts) {
      walked = walked === '' ? part : `${walked}/${part}`
      if (this.known.has(walked)) continue
      await fetch(this.urlFor(walked), { method: 'MKCOL', headers: this.headers() })
      this.known.add(walked)
    }
  }

  async put(path: string, data: Bytes): Promise<void> {
    this.requireCredentials()
    const url = this.urlFor(path)
    const send = (): Promise<Response> =>
      fetch(url, {
        method: 'PUT',
        headers: this.headers({ 'content-type': 'application/octet-stream' }),
        body: data as unknown as BodyInit,
      })

    let response = await send()
    if (response.status === 409 || response.status === 404) {
      await this.makeFolders(path)
      response = await send()
    }
    if (!response.ok) {
      throw new Error(`storage write failed with ${String(response.status)} for "${path}"`)
    }
  }

  async list(prefix: string, after?: string): Promise<StorageEntry[]> {
    const response = await fetch(`${this.baseUrl}/${prefix}`, {
      method: 'PROPFIND',
      // 1階層だけ。無限に降りると、添付の多いグループで待たされる
      headers: this.headers({ depth: '1' }),
    })
    if (response.status === 404) return []
    if (!response.ok) {
      throw new Error(`storage list failed with ${String(response.status)} for "${prefix}"`)
    }
    return parsePropfind(await response.text(), this.baseUrl, prefix)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .filter((entry) => after === undefined || entry.path > after)
  }

  async delete(path: string): Promise<void> {
    this.requireCredentials()
    const response = await fetch(this.urlFor(path), {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!response.ok && response.status !== 404) {
      throw new Error(`storage delete failed with ${String(response.status)} for "${path}"`)
    }
  }
}

/**
 * PROPFIND の答えから子の一覧を取り出す。
 *
 * DOMParser は Service Worker やテストの実行環境に無いことがあるので、
 * 名前空間の接頭辞に寛容な取り出しを自分で行う。
 */
export function parsePropfind(xml: string, baseUrl: string, prefix: string): StorageEntry[] {
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '')
  const entries: StorageEntry[] = []
  const responses = xml.split(/<[a-zA-Z0-9]*:?response[\s>]/).slice(1)

  for (const block of responses) {
    const href = /<[a-zA-Z0-9]*:?href[^>]*>([^<]+)</.exec(block)?.[1]
    if (!href) continue
    const decoded = decodeURIComponent(href.trim())
    const withoutBase = decoded.startsWith(basePath) ? decoded.slice(basePath.length) : decoded
    const path = withoutBase.replace(/^\/+/, '')
    // フォルダ自身は必ず返ってくる。数に入れない
    if (path === '' || path === prefix || path === prefix.replace(/\/+$/, '')) continue
    if (path.endsWith('/')) continue

    const size = /<[a-zA-Z0-9]*:?getcontentlength[^>]*>([0-9]+)</.exec(block)?.[1]
    entries.push({ path, size: size ? Number(size) : 0 })
  }
  return entries
}
