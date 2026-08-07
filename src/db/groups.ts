import Dexie from 'dexie'
import type { Table } from 'dexie'
import type { ConnectionCode } from '../group/connection-code'
import { decodeConnectionCode, encodeConnectionCode } from '../group/connection-code'

export interface StoredGroup {
  groupId: string
  groupName: string
  /** 接続コード(base64url)。秘密情報ではない。 */
  code: string
  loginId: string
  lastLoginAt: number
}

export class GroupRegistryDb extends Dexie {
  groups!: Table<StoredGroup, string>

  constructor() {
    super('mofune_registry')
    this.version(1).stores({ groups: 'groupId, lastLoginAt' })
  }
}

export const registryDb = new GroupRegistryDb()

/**
 * 端末に保存するのは接続コードとログイン ID のみ。
 * パスワードと秘密鍵は決して保存しない。
 */
export async function rememberGroup(input: {
  code: ConnectionCode
  groupName: string
  loginId: string
  at: number
}): Promise<void> {
  await registryDb.groups.put({
    groupId: input.code.groupId,
    groupName: input.groupName,
    code: encodeConnectionCode(input.code),
    loginId: input.loginId,
    lastLoginAt: input.at,
  })
}

export async function listGroups(): Promise<StoredGroup[]> {
  return registryDb.groups.orderBy('lastLoginAt').reverse().toArray()
}

export async function getGroup(
  groupId: string,
): Promise<{ code: ConnectionCode; groupName: string; loginId: string } | undefined> {
  const stored = await registryDb.groups.get(groupId)
  if (!stored) return undefined
  return {
    code: decodeConnectionCode(stored.code),
    groupName: stored.groupName,
    loginId: stored.loginId,
  }
}

export async function forgetGroup(groupId: string): Promise<void> {
  await registryDb.groups.delete(groupId)
}
