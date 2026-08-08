import type { ConnectionCode } from '../group/connection-code'
import { readGroupSettings } from '../group/group-settings'
import type { Session } from '../group/session'
import { readStorageSettings, toProviderConfig } from '../group/storage-credentials'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import { FunctionStorageProvider } from './function'
import { HttpStorageProvider } from './http'
import type { StorageProvider } from './provider'
import { S3StorageProvider } from './s3'
import { WebdavStorageProvider } from './webdav'

/**
 * 接続コードから、その置き場に合った経路を組み立てる。
 *
 * 読みは誰でもできる経路、書きは資格情報を持つ人だけの経路。2本に分けるのは、
 * 参加者に書き込みの資格情報を渡さないため (設計書 §5)。
 */
export function readProviderFor(code: ConnectionCode): StorageProvider {
  // Drive は Apps Script の所有者権限で読み書きする。root はその /exec の URL
  if (code.provider === 'gdrive') {
    return new FunctionStorageProvider({ functionUrl: code.root, groupId: code.groupId })
  }
  // WebDAV は公開共有の起点にパスを継ぎ足して読む。一覧も取れる
  if (code.provider === 'webdav') {
    return new WebdavStorageProvider({ baseUrl: code.root })
  }
  return new HttpStorageProvider(code.root)
}

/**
 * 担当者・管理者のための書き込み経路。参加者では必ず null になる。
 * 資格情報も合言葉も staff スコープ鍵でしか開けない場所に置いてある。
 */
export async function writerFor(options: {
  code: ConnectionCode
  session: Session
  storage: StorageProvider
}): Promise<StorageProvider | null> {
  const { code, session, storage } = options
  if (session.role === 'member') return null

  if (code.provider === 'gdrive') {
    const staffKey = session.groupKeys.get(keyId(STAFF_SCOPE, session.generation))
    if (!staffKey) return null
    try {
      const settings = await readGroupSettings({ storage, groupId: session.groupId, staffKey })
      const token = settings.notifications.functionToken
      if (token === '') return null
      return new FunctionStorageProvider({
        functionUrl: code.root,
        groupId: session.groupId,
        token,
      })
    } catch {
      return null
    }
  }

  try {
    const settings = await readStorageSettings({
      storage,
      groupId: session.groupId,
      keys: session.groupKeys,
    })
    if (settings.provider === 'webdav') {
      return new WebdavStorageProvider({
        baseUrl: settings.baseUrl,
        credentials: { username: settings.username, password: settings.password },
      })
    }
    return new S3StorageProvider(toProviderConfig(settings))
  } catch {
    // 資格情報がまだ置かれていないグループもある。読むだけなら支障はない
    return null
  }
}
