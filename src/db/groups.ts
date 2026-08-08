import Dexie from 'dexie'
import type { Table } from 'dexie'
import type { ConnectionCode } from '../group/connection-code'
import { decodeConnectionCode, encodeConnectionCode } from '../group/connection-code'

export interface StoredGroup {
  groupId: string
  groupName: string
  /** 接続コード(base64url)。秘密情報ではない。 */
  code: string
  /** ログインの識別子。メールアドレス。 */
  email: string
  lastLoginAt: number
}

export class GroupRegistryDb extends Dexie {
  groups!: Table<StoredGroup, string>

  constructor() {
    super('mofune_registry')
    this.version(1).stores({ groups: 'groupId, lastLoginAt' })
    // ログインの識別子をログインIDからメールアドレスへ変えた。
    // 既存端末の記録は移し替える。消すと接続コードの打ち直しになる。
    this.version(2)
      .stores({ groups: 'groupId, lastLoginAt' })
      .upgrade(async (tx) => {
        await tx
          .table('groups')
          .toCollection()
          .modify((row: StoredGroup & { loginId?: string }) => {
            if (row.email === undefined && row.loginId !== undefined) {
              row.email = row.loginId
              delete row.loginId
            }
          })
      })
  }
}

export const registryDb = new GroupRegistryDb()

/**
 * 端末に保存するのは接続コードとメールアドレスのみ。
 * パスワードと秘密鍵は決して保存しない。
 */
export async function rememberGroup(input: {
  code: ConnectionCode
  groupName: string
  email: string
  at: number
}): Promise<void> {
  await registryDb.groups.put({
    groupId: input.code.groupId,
    groupName: input.groupName,
    code: encodeConnectionCode(input.code),
    email: input.email,
    lastLoginAt: input.at,
  })
}

export async function listGroups(): Promise<StoredGroup[]> {
  return registryDb.groups.orderBy('lastLoginAt').reverse().toArray()
}

export async function getGroup(
  groupId: string,
): Promise<{ code: ConnectionCode; groupName: string; email: string } | undefined> {
  const stored = await registryDb.groups.get(groupId)
  if (!stored) return undefined
  return {
    code: decodeConnectionCode(stored.code),
    groupName: stored.groupName,
    email: stored.email,
  }
}

export async function forgetGroup(groupId: string): Promise<void> {
  await registryDb.groups.delete(groupId)
}
