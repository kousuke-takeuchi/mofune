import type { Bytes } from '../crypto/bytes'
import { fromUtf8, utf8 } from '../crypto/bytes'
import type { StorageProvider } from '../storage/provider'
import { manifestPath } from '../storage/paths'

export class ManifestError extends Error {}

export const MANIFEST_VERSION = 1

/** 平文で保存される唯一のグループメタデータ。個人情報を入れてはならない。 */
export interface Manifest {
  v: number
  groupId: string
  groupName: string
  keyringGeneration: number
  rosterGeneration: number
  /** 任意の関数層のエンドポイント。未導入なら null。 */
  functionUrl: string | null
  notificationChannels: string[]
}

export function encodeManifest(manifest: Manifest): Bytes {
  return utf8(JSON.stringify(manifest))
}

export function decodeManifest(bytes: Bytes): Manifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new ManifestError('manifest is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new ManifestError('manifest is not an object')
  }
  const candidate = parsed as Record<string, unknown>
  if (candidate.v !== MANIFEST_VERSION) {
    throw new ManifestError(`unsupported manifest version ${String(candidate.v)}`)
  }
  if (
    typeof candidate.groupId !== 'string' ||
    typeof candidate.groupName !== 'string' ||
    typeof candidate.keyringGeneration !== 'number' ||
    typeof candidate.rosterGeneration !== 'number'
  ) {
    throw new ManifestError('manifest is missing required fields')
  }
  return {
    v: MANIFEST_VERSION,
    groupId: candidate.groupId,
    groupName: candidate.groupName,
    keyringGeneration: candidate.keyringGeneration,
    rosterGeneration: candidate.rosterGeneration,
    functionUrl: typeof candidate.functionUrl === 'string' ? candidate.functionUrl : null,
    notificationChannels: Array.isArray(candidate.notificationChannels)
      ? candidate.notificationChannels.filter(
          (channel): channel is string => typeof channel === 'string',
        )
      : [],
  }
}

/**
 * 通知用の関数の URL を差し替える (設計書 §10)。
 *
 * manifest に置くのは、購読を作る参加者もログイン前後を問わず読める必要があるため。
 * 合言葉のほうは staff スコープの設定に隠す。書けるのは資格情報を持つ側だけ。
 */
export async function setFunctionUrl(options: {
  storage: StorageProvider
  groupId: string
  /** 空文字なら関数を使わない状態に戻す。 */
  functionUrl: string
}): Promise<Manifest> {
  const manifest = decodeManifest(await options.storage.get(manifestPath(options.groupId)))
  const trimmed = options.functionUrl.trim().replace(/\/+$/, '')
  const next: Manifest = { ...manifest, functionUrl: trimmed === '' ? null : trimmed }
  await options.storage.put(manifestPath(options.groupId), encodeManifest(next))
  return next
}
