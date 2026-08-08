import type { Bytes } from '../crypto/bytes'
import { fromBase64 } from '../crypto/bytes'
import type { KeyringFile } from '../crypto/keyring'
import { keyId, parseKeyringFile, unwrapKey, wrapKey } from '../crypto/keyring'
import type { RosterContents, RosterMember } from '../crypto/roster'
import {
  STAFF_SCOPE,
  serializeRosterFile,
  signRoster,
  verifyRoster,
} from '../crypto/roster'
import { generateAesKey } from '../crypto/symmetric'
import { publishGrants } from '../inbox/grants'
import { keyringPath, rosterPath } from '../storage/paths'
import type { StorageProvider } from '../storage/provider'
import type { ConnectionCode } from './connection-code'
import { readContacts, sealContacts, withContact } from './contacts'
import { loadRosterFile } from './roster-update'
import type { Session } from './session'
import type { StorageSettings } from './storage-credentials'

/**
 * 名簿と鍵束を書き換える側の共通部品。
 *
 * メンバーの増減もサブグループの増減も、やることは「鍵を配る」「名簿を再署名する」
 * の2つに落ちる。同じ手順を2箇所で書くと、片方だけ直して名簿が壊れる。
 */
export class RosterWriteError extends Error {}

/** 名簿から自分の公開鍵を引く。新しく作った鍵を自分にも配るために要る。 */
export function adminPublic(contents: RosterContents, userId: string): Bytes {
  const me = contents.members.find((candidate) => candidate.userId === userId)
  if (!me) {
    throw new RosterWriteError('自分が名簿にいません')
  }
  return fromBase64(me.ecdhPublic)
}

/**
 * 名簿を再署名できるのは管理者だけ。信頼の根の ECDSA 鍵を持つのが管理者しかいない。
 * 呼び出し側の例外型で投げるのは、画面がどの操作で断られたか分かるようにするため。
 */
export function assertAdmin(
  session: Session,
  Failure: new (message: string) => Error = RosterWriteError,
): void {
  if (session.role !== 'admin') {
    throw new Failure('この操作ができるのは管理者だけです')
  }
}

/** いまの鍵束を読み、管理者が開ける鍵をすべて取り出す。 */
export async function openKeyring(options: {
  storage: StorageProvider
  groupId: string
  generation: number
  session: Session
}): Promise<{ file: KeyringFile; keys: Map<string, CryptoKey> }> {
  const file = parseKeyringFile(
    await options.storage.get(keyringPath(options.groupId, options.generation)),
  )
  const keys = new Map<string, CryptoKey>()
  for (const [id, entry] of Object.entries(file.keys)) {
    const wrapped = entry.wrapped[options.session.userId]
    if (!wrapped) continue
    keys.set(id, await unwrapKey(wrapped, options.session.ecdhPrivate))
  }
  return { file, keys }
}

/**
 * 鍵束に1人ぶんのラップを足す(または差し替える)。
 *
 * 世代は上げない。世代は鍵そのものが変わったときのためにあり、追加は同じ鍵を
 * 新しい相手にも配るだけ。上げると manifest まで更新することになり、全端末が
 * 読み直す羽目になる。
 */
export async function grantScopes(options: {
  file: KeyringFile
  keys: Map<string, CryptoKey>
  userId: string
  ecdhPublic: Bytes
  scopes: string[]
  generation: number
  adminUserId: string
  adminEcdhPublic: Bytes
}): Promise<KeyringFile> {
  const next: KeyringFile = { ...options.file, keys: { ...options.file.keys } }
  for (const scope of options.scopes) {
    const id = keyId(scope, options.generation)
    const entry = next.keys[id]

    if (!entry) {
      // まだ誰も所属していないサブグループには鍵が無い。ここで作る。
      // 管理者にも配っておかないと、次に人を足すとき鍵を開けられなくなる。
      const key = await generateAesKey()
      next.keys[id] = {
        scope,
        generation: options.generation,
        wrapped: {
          [options.userId]: await wrapKey(options.ecdhPublic, key),
          [options.adminUserId]: await wrapKey(options.adminEcdhPublic, key),
        },
      }
      continue
    }

    const key = options.keys.get(id)
    if (!key) {
      // 管理者がそのスコープに所属していないと開けられない。鍵を作り直すと
      // 既存の所属者が読めなくなるので、黙って壊さず断る。
      throw new RosterWriteError(
        `"${scope}" の鍵を開けません。管理者がそのサブグループに所属している必要があります`,
      )
    }
    next.keys[id] = {
      ...entry,
      wrapped: { ...entry.wrapped, [options.userId]: await wrapKey(options.ecdhPublic, key) },
    }
  }
  return next
}

/** 名簿を書き換えて再署名し、書き戻す。連絡先は staff 部に入れる。 */
export async function reSignRoster(options: {
  storage: StorageProvider
  session: Session
  code: ConnectionCode
  generation: number
  change: (contents: RosterContents) => RosterMember[]
  /** サブグループを差し替えるとき。省略すればそのまま。 */
  subgroups?: RosterContents['subgroups']
  contact?: { userId: string; email: string }
}): Promise<RosterContents> {
  const adminPublicKey = fromBase64(options.code.adminPublicKey)
  const file = await loadRosterFile({ storage: options.storage, groupId: options.code.groupId })
  const contents = await verifyRoster(file, adminPublicKey)

  const staffKey = options.session.groupKeys.get(keyId(STAFF_SCOPE, options.generation))
  if (!staffKey) {
    throw new RosterWriteError('staff スコープ鍵を持っていません')
  }

  let contacts = await readContacts({ file, staffKey })
  if (options.contact) {
    contacts = withContact(contacts, options.contact.userId, options.contact.email)
  }

  const next: RosterContents = {
    ...contents,
    generation: contents.generation + 1,
    subgroups: options.subgroups ?? contents.subgroups,
    members: options.change(contents),
  }
  const staffSection = await sealContacts({
    contacts,
    staffKey,
    generation: options.generation,
  })
  const signed = await signRoster(next, staffSection, {
    publicKey: adminPublicKey,
    privateKey: options.session.ecdsaPrivate,
  })
  // 署名を誤った名簿を置くと全員がログインできなくなる。書く前に自分で検証する。
  await verifyRoster(signed, adminPublicKey)
  await options.storage.put(rosterPath(options.code.groupId), serializeRosterFile(signed))
  return next
}

/** その人だけに投函枠を配り直す。 */
export async function issueGrantFor(options: {
  storage: StorageProvider
  groupId: string
  roster: RosterContents
  settings: StorageSettings
  userId: string
}): Promise<void> {
  const member = options.roster.members.find((candidate) => candidate.userId === options.userId)
  if (!member || member.role !== 'member') return
  // presigned URL を作れない置き場では枠を配らない。上りは関数層が受ける
  if (options.settings.provider !== 's3') return
  await publishGrants({
    storage: options.storage,
    groupId: options.groupId,
    roster: { ...options.roster, members: [member] },
    settings: options.settings,
  })
}

