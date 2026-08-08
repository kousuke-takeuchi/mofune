import type { Bytes } from '../crypto/bytes'
import { fromBase64 } from '../crypto/bytes'
import type { KeyringFile } from '../crypto/keyring'
import { keyId, serializeKeyringFile, wrapKey } from '../crypto/keyring'
import type { RosterContents } from '../crypto/roster'
import { STAFF_SCOPE, verifyRoster } from '../crypto/roster'
import { generateAesKey } from '../crypto/symmetric'
import type { KdfParams } from '../crypto/kdf'
import { keyringPath, keystorePath, manifestPath } from '../storage/paths'
import type { StorageProvider } from '../storage/provider'
import type { ConnectionCode } from './connection-code'
import { readContacts } from './contacts'
import { decodeManifest, encodeManifest } from './manifest'
import { loadRosterFile } from './roster-update'
import { adminPublic, assertAdmin, openKeyring, reSignRoster } from './roster-writer'
import type { Session } from './session'
import type { StorageSettings } from './storage-credentials'

export class RotationError extends Error {}

interface Context {
  storage: StorageProvider
  session: Session
  code: ConnectionCode
  settings: StorageSettings
  kdf?: KdfParams
}

/** その世代のスコープ名を並べる。 */
function scopesAt(file: KeyringFile, generation: number): string[] {
  return [
    ...new Set(
      Object.values(file.keys)
        .filter((entry) => entry.generation === generation)
        .map((entry) => entry.scope),
    ),
  ].sort()
}

/**
 * 指定したスコープの鍵を作り直し、残る人にだけ配る。
 *
 * 古い世代のエントリは**そのまま残す**。消すと、残った人が過去のお知らせを
 * 読めなくなる。抜けた人のラップだけを落とす。
 */
async function rotate(options: {
  storage: StorageProvider
  groupId: string
  previous: KeyringFile
  previousGeneration: number
  roster: RosterContents
  removedUserId: string
  scopes: string[]
  /** 作り直した鍵は管理者にも配る。配らないと次に人を入れるとき開けられない。 */
  adminUserId: string
  adminEcdhPublic: Bytes
}): Promise<number> {
  const generation = options.previousGeneration + 1

  // 旧世代は残すが、抜けた人のラップは落とす
  const keys: KeyringFile['keys'] = {}
  for (const [id, entry] of Object.entries(options.previous.keys)) {
    const wrapped = { ...entry.wrapped }
    delete wrapped[options.removedUserId]
    keys[id] = { ...entry, wrapped }
  }

  for (const scope of options.scopes) {
    const key = await generateAesKey()
    const wrapped: KeyringFile['keys'][string]['wrapped'] = {}
    for (const member of options.roster.members) {
      if (!member.scopes.includes(scope)) continue
      wrapped[member.userId] = await wrapKey(fromBase64(member.ecdhPublic), key)
    }
    if (!wrapped[options.adminUserId]) {
      wrapped[options.adminUserId] = await wrapKey(options.adminEcdhPublic, key)
    }
    keys[keyId(scope, generation)] = { scope, generation, wrapped }
  }

  await options.storage.put(
    keyringPath(options.groupId, generation),
    serializeKeyringFile({ ...options.previous, generation, keys }),
  )

  // manifest を上げてから初めて、みんなが新しい鍵束を読む
  const manifest = decodeManifest(await options.storage.get(manifestPath(options.groupId)))
  await options.storage.put(
    manifestPath(options.groupId),
    encodeManifest({ ...manifest, keyringGeneration: generation }),
  )
  return generation
}

/**
 * メンバーを外す。管理者のみ。
 *
 * その人が持っていたスコープの鍵を作り直す。作り直さないと、抜けたあとに配る
 * ものまで読まれてしまう。**過去に配ったものは読まれ続ける**。相手の端末にある
 * 控えは取り上げられないので、これは仕組み上どうにもならない。
 *
 * キーストアも消してログインできなくする。ただし相手が自分のキーストアと
 * 古い鍵束の写しを取っていれば、古いお知らせは開ける。
 */
export async function removeMember(
  context: Context & { userId: string },
): Promise<{ generation: number }> {
  assertAdmin(context.session, RotationError)

  if (context.userId === context.session.userId) {
    throw new RotationError('自分を外すことはできません')
  }

  const file = await loadRosterFile({ storage: context.storage, groupId: context.code.groupId })
  const contents = await verifyRoster(file, fromBase64(context.code.adminPublicKey))
  const target = contents.members.find((member) => member.userId === context.userId)
  if (!target) {
    throw new RotationError('その人は名簿にいません')
  }
  const admins = contents.members.filter((member) => member.role === 'admin')
  if (target.role === 'admin' && admins.length <= 1) {
    // 名簿を再署名できる人がいなくなると、そのグループは二度と直せない
    throw new RotationError('最後の管理者は外せません')
  }

  // 名簿から外してから鍵を配る。順序が逆だと、外れる人にも新しい鍵が渡る。
  const updated = await reSignRoster({
    storage: context.storage,
    session: context.session,
    code: context.code,
    generation: context.session.generation,
    change: (current) => current.members.filter((member) => member.userId !== context.userId),
  })

  const { file: keyring } = await openKeyring({
    storage: context.storage,
    groupId: context.code.groupId,
    generation: context.session.generation,
    session: context.session,
  })

  /*
   * 世代は全体で1つなので、**その世代の全スコープ**を作り直す。
   * 抜けた人が持っていた鍵だけ更新すると、たとえば staff だけ旧世代のまま残り、
   * 「いまの世代の staff 鍵が無い」状態になって名簿の再署名ができなくなる。
   * 実機で踏んだ。余分に作り直す手間より、世代が揃っている方が安い。
   */
  const held = scopesAt(keyring, context.session.generation)
  const generation = await rotate({
    storage: context.storage,
    groupId: context.code.groupId,
    previous: keyring,
    previousGeneration: context.session.generation,
    roster: updated,
    removedUserId: context.userId,
    scopes: held,
    adminUserId: context.session.userId,
    adminEcdhPublic: adminPublic(contents, context.session.userId),
  })

  // ログインできないようにする。鍵を替えただけでは、本人は入れてしまう。
  // 置き場所はアドレスから決まるので、連絡先 (staff 部) から引く。
  const staffKey = context.session.groupKeys.get(
    keyId(STAFF_SCOPE, context.session.generation),
  )
  if (staffKey) {
    const contacts = await readContacts({ file, staffKey })
    const email = contacts[context.userId]?.email
    if (email) {
      await context.storage
        .delete(await keystorePath(context.code.groupId, email))
        .catch(() => undefined)
    }
  }

  return { generation }
}
