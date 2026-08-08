import { fromUtf8, utf8 } from '../crypto/bytes'
import { openEnvelope, sealEnvelopeFor } from '../crypto/envelope'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import type { S3ProviderConfig } from '../storage/s3'
import type { StorageProvider } from '../storage/provider'

export class StorageCredentialsError extends Error {}

/**
 * WebDAV (Nextcloud・NAS) の置き場。参加者は publicBaseUrl を資格情報なしで読み、
 * 担当者は同じ場所へ Basic 認証で書く。
 */
export interface WebdavStorageSettings {
  provider: 'webdav'
  /** 書き込みに使う起点。共有フォルダの WebDAV URL。 */
  baseUrl: string
  /** 参加者が資格情報なしで読む起点。公開共有の URL で、接続コードの root になる。 */
  publicBaseUrl: string
  username: string
  password: string
}

export type StorageSettings = S3StorageSettings | WebdavStorageSettings

export interface S3StorageSettings {
  provider: 's3'
  /** 読み書きに使う S3 API のエンドポイント。SigV4 で署名する。 */
  endpoint: string
  region: string
  bucket: string
  /**
   * 参加者が資格情報なしで読む URL の起点。エンドポイントとは別物で、
   * R2 なら r2.dev の公開URLか独自ドメイン。接続コードの root になる。
   */
  publicBaseUrl: string
  accessKeyId: string
  secretAccessKey: string
}

export function storageSettingsPath(groupId: string): string {
  return `${groupId}/settings/storage.enc`
}

export async function writeStorageSettings(options: {
  storage: StorageProvider
  groupId: string
  settings: StorageSettings
  staffKey: CryptoKey
  generation: number
}): Promise<void> {
  const sealed = await sealEnvelopeFor(
    [{ keyId: keyId(STAFF_SCOPE, options.generation), key: options.staffKey }],
    utf8(JSON.stringify(options.settings)),
  )
  await options.storage.put(storageSettingsPath(options.groupId), sealed)
}

/**
 * staff スコープ鍵を持つ者(管理者・担当者)だけが読める。
 * 結果はメモリ上のセッションにのみ保持し、IndexedDB に書いてはならない。
 */
export async function readStorageSettings(options: {
  storage: StorageProvider
  groupId: string
  keys: ReadonlyMap<string, CryptoKey>
}): Promise<StorageSettings> {
  let sealed
  try {
    sealed = await options.storage.get(storageSettingsPath(options.groupId))
  } catch {
    throw new StorageCredentialsError('no storage settings have been written for this group')
  }
  try {
    return JSON.parse(fromUtf8(await openEnvelope(options.keys, sealed))) as StorageSettings
  } catch {
    throw new StorageCredentialsError('storage settings could not be decrypted with these keys')
  }
}

export function toProviderConfig(settings: S3StorageSettings): S3ProviderConfig {
  return {
    endpoint: settings.endpoint,
    region: settings.region,
    bucket: settings.bucket,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
  }
}
