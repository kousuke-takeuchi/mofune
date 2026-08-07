import { fromUtf8, utf8 } from '../crypto/bytes'
import { openEnvelope, sealEnvelopeFor } from '../crypto/envelope'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import type { S3ProviderConfig } from '../storage/s3'
import type { StorageProvider } from '../storage/provider'

export class StorageCredentialsError extends Error {}

export interface StorageSettings {
  provider: 's3'
  endpoint: string
  region: string
  bucket: string
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

export function toProviderConfig(settings: StorageSettings): S3ProviderConfig {
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
