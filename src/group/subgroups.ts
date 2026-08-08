import { toHex } from '../crypto/bytes'
import { fromBase64 } from '../crypto/bytes'
import { serializeKeyringFile } from '../crypto/keyring'
import { resolveScopes, verifyRoster } from '../crypto/roster'
import { randomBytes } from '../crypto/symmetric'
import { keyringPath } from '../storage/paths'
import type { StorageProvider } from '../storage/provider'
import type { ConnectionCode } from './connection-code'
import { loadRosterFile } from './roster-update'
import {
  adminPublic,
  assertAdmin,
  grantScopes,
  issueGrantFor,
  openKeyring,
  reSignRoster,
} from './roster-writer'
import type { Session } from './session'
import type { StorageSettings } from './storage-credentials'

export class SubgroupError extends Error {}

interface Context {
  storage: StorageProvider
  session: Session
  code: ConnectionCode
}

/**
 * サブグループを1つ作る。管理者のみ。
 *
 * 鍵はここでは作らない。誰も所属していないサブグループの鍵は要らないし、
 * 最初の1人を入れるときに作られる (roster-writer の grantScopes)。
 */
export async function createSubgroup(
  context: Context & { name: string; parent: string | null },
): Promise<{ id: string }> {
  assertAdmin(context.session, SubgroupError)

  const name = context.name.trim()
  if (name.length === 0) {
    throw new SubgroupError('サブグループの名前を入れてください')
  }

  const file = await loadRosterFile({ storage: context.storage, groupId: context.code.groupId })
  const contents = await verifyRoster(file, fromBase64(context.code.adminPublicKey))

  if (context.parent !== null && !contents.subgroups.some((g) => g.id === context.parent)) {
    throw new SubgroupError('親にするサブグループが見つかりません')
  }

  const id = `sg_${toHex(randomBytes(4))}`
  await reSignRoster({
    storage: context.storage,
    session: context.session,
    code: context.code,
    generation: context.session.generation,
    subgroups: [...contents.subgroups, { id, name, parent: context.parent }],
    change: (current) => current.members,
  })
  return { id }
}

/**
 * その人の所属を置き換える。管理者のみ。
 *
 * **外した所属の鍵は取り上げられない。** 一度渡した鍵は相手の端末にあり、
 * 過去に配られた内容は読めるままになる。本当に読ませたくないなら鍵の
 * ローテーションが要る。画面にその旨を出すこと。
 */
export async function setMemberScopes(
  context: Context & { settings: StorageSettings; userId: string; scopes: string[] },
): Promise<void> {
  assertAdmin(context.session, SubgroupError)

  const file = await loadRosterFile({ storage: context.storage, groupId: context.code.groupId })
  const contents = await verifyRoster(file, fromBase64(context.code.adminPublicKey))
  const member = contents.members.find((candidate) => candidate.userId === context.userId)
  if (!member) {
    throw new SubgroupError('その人は名簿にいません')
  }

  const resolved = resolveScopes(contents.subgroups, member.role, context.scopes)

  const { file: keyring, keys } = await openKeyring({
    storage: context.storage,
    groupId: context.code.groupId,
    generation: context.session.generation,
    session: context.session,
  })
  const nextKeyring = await grantScopes({
    file: keyring,
    keys,
    userId: context.userId,
    ecdhPublic: fromBase64(member.ecdhPublic),
    scopes: resolved,
    generation: context.session.generation,
    adminUserId: context.session.userId,
    adminEcdhPublic: adminPublic(contents, context.session.userId),
  })
  await context.storage.put(
    keyringPath(context.code.groupId, context.session.generation),
    serializeKeyringFile(nextKeyring),
  )

  const updated = await reSignRoster({
    storage: context.storage,
    session: context.session,
    code: context.code,
    generation: context.session.generation,
    change: (current) =>
      current.members.map((candidate) =>
        candidate.userId === context.userId ? { ...candidate, scopes: resolved } : candidate,
      ),
  })

  await issueGrantFor({
    storage: context.storage,
    groupId: context.code.groupId,
    roster: updated,
    settings: context.settings,
    userId: context.userId,
  })
}
