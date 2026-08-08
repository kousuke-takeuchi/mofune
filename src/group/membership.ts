import { generateEcdhKeyPair, generateEcdsaKeyPair } from '../crypto/asymmetric'
import type { RawKeyPair } from '../crypto/asymmetric'
import type { Bytes } from '../crypto/bytes'
import { fromBase64, toBase64, toHex } from '../crypto/bytes'
import type { KdfParams } from '../crypto/kdf'
import { PRODUCTION_KDF } from '../crypto/kdf'
import type { KeyringFile } from '../crypto/keyring'
import {
  keyId,
  parseKeyringFile,
  serializeKeyringFile,
  unwrapKey,
  wrapKey,
} from '../crypto/keyring'
import { createKeystore, serializeKeystoreFile } from '../crypto/keystore'
import type { Role, RosterContents, RosterMember } from '../crypto/roster'
import { STAFF_SCOPE, resolveScopes, serializeRosterFile, signRoster, verifyRoster } from '../crypto/roster'
import { generateAesKey, randomBytes } from '../crypto/symmetric'
import { publishGrants } from '../inbox/grants'
import { keyringPath, keystorePath, rosterPath } from '../storage/paths'
import type { StorageProvider } from '../storage/provider'
import type { ConnectionCode } from './connection-code'
import { readContacts, sealContacts, withContact } from './contacts'
import { INITIAL_GENERATION } from './provision'
import { loadRosterFile } from './roster-update'
import type { Session } from './session'
import type { StorageSettings } from './storage-credentials'

export class MembershipError extends Error {}

export interface NewMemberInput {
  loginId: string
  displayName: string
  role: Role
  /** 末端のサブグループ id のみ。all・祖先・staff は resolveScopes が付ける。 */
  scopes: string[]
  password: string
  email: string
}

interface Context {
  storage: StorageProvider
  session: Session
  code: ConnectionCode
  settings: StorageSettings
  kdf?: KdfParams
}

/** 名簿から自分の公開鍵を引く。新しく作った鍵を自分にも配るために要る。 */
function adminPublic(contents: RosterContents, userId: string): Bytes {
  const me = contents.members.find((candidate) => candidate.userId === userId)
  if (!me) {
    throw new MembershipError('自分が名簿にいません')
  }
  return fromBase64(me.ecdhPublic)
}

function assertAdmin(session: Session): void {
  // 名簿を再署名できるのは管理者だけ。信頼の根の ECDSA 鍵を持つのが管理者しかいない。
  if (session.role !== 'admin') {
    throw new MembershipError('メンバーを変更できるのは管理者だけです')
  }
}

/** いまの鍵束を読み、管理者が開ける鍵をすべて取り出す。 */
async function openKeyring(options: {
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
async function grantScopes(options: {
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
      throw new MembershipError(
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
async function reSignRoster(options: {
  storage: StorageProvider
  session: Session
  code: ConnectionCode
  generation: number
  change: (contents: RosterContents) => RosterMember[]
  contact?: { userId: string; email: string }
}): Promise<RosterContents> {
  const adminPublicKey = fromBase64(options.code.adminPublicKey)
  const file = await loadRosterFile({ storage: options.storage, groupId: options.code.groupId })
  const contents = await verifyRoster(file, adminPublicKey)

  const staffKey = options.session.groupKeys.get(keyId(STAFF_SCOPE, options.generation))
  if (!staffKey) {
    throw new MembershipError('staff スコープ鍵を持っていません')
  }

  let contacts = await readContacts({ file, staffKey })
  if (options.contact) {
    contacts = withContact(contacts, options.contact.userId, options.contact.email)
  }

  const next: RosterContents = {
    ...contents,
    generation: contents.generation + 1,
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
async function issueGrantFor(options: {
  storage: StorageProvider
  groupId: string
  roster: RosterContents
  settings: StorageSettings
  userId: string
}): Promise<void> {
  const member = options.roster.members.find((candidate) => candidate.userId === options.userId)
  if (!member || member.role !== 'member') return
  await publishGrants({
    storage: options.storage,
    groupId: options.groupId,
    roster: { ...options.roster, members: [member] },
    settings: options.settings,
  })
}

async function placeKeystore(options: {
  storage: StorageProvider
  groupId: string
  loginId: string
  userId: string
  pair: { ecdh: RawKeyPair; ecdsa: RawKeyPair }
  password: string
  pepper: string
  kdf: KdfParams
}): Promise<void> {
  const keystore = await createKeystore(
    { userId: options.userId, ecdh: options.pair.ecdh, ecdsa: options.pair.ecdsa },
    options.password,
    options.pepper,
    options.kdf,
  )
  await options.storage.put(
    await keystorePath(options.groupId, options.loginId),
    serializeKeystoreFile(keystore),
  )
}

/**
 * メンバーを1人足す。管理者のみ。
 *
 * 追加した人は過去のお知らせも読める。スコープ鍵が同じだから当然そうなる。
 * 隠したいなら鍵のローテーションが要る(削除と同じ仕組み)。
 */
export async function addMember(
  context: Context & { member: NewMemberInput },
): Promise<{ userId: string }> {
  assertAdmin(context.session)

  const wanted = context.member.loginId.trim().toLowerCase()
  if (wanted.length === 0) {
    throw new MembershipError('ログインIDを入れてください')
  }
  // ログインIDはキーストアのファイル名になる。重複すると先の人を上書きしてしまう。
  const taken = await context.storage
    .get(await keystorePath(context.code.groupId, wanted))
    .then(() => true)
    .catch(() => false)
  if (taken) {
    throw new MembershipError(`ログインID "${wanted}" はすでに使われています`)
  }

  const generation = INITIAL_GENERATION
  const { file, keys } = await openKeyring({
    storage: context.storage,
    groupId: context.code.groupId,
    generation,
    session: context.session,
  })

  const ecdh = await generateEcdhKeyPair()
  const ecdsa = await generateEcdsaKeyPair()
  const userId = `u_${toHex(randomBytes(8))}`

  const roster = await loadRosterFile({
    storage: context.storage,
    groupId: context.code.groupId,
  })
  const contents = await verifyRoster(roster, fromBase64(context.code.adminPublicKey))
  const scopes = resolveScopes(contents.subgroups, context.member.role, context.member.scopes)

  await placeKeystore({
    storage: context.storage,
    groupId: context.code.groupId,
    loginId: wanted,
    userId,
    pair: { ecdh, ecdsa },
    password: context.member.password,
    pepper: context.code.pepper,
    kdf: context.kdf ?? PRODUCTION_KDF,
  })

  const nextKeyring = await grantScopes({
    file,
    keys,
    userId,
    ecdhPublic: ecdh.publicKey,
    scopes,
    generation,
    adminUserId: context.session.userId,
    adminEcdhPublic: adminPublic(contents, context.session.userId),
  })
  await context.storage.put(
    keyringPath(context.code.groupId, generation),
    serializeKeyringFile(nextKeyring),
  )

  const updated = await reSignRoster({
    storage: context.storage,
    session: context.session,
    code: context.code,
    generation,
    contact: { userId, email: context.member.email },
    change: (current) => [
      ...current.members,
      {
        userId,
        displayName: context.member.displayName,
        role: context.member.role,
        scopes,
        ecdhPublic: toBase64(ecdh.publicKey),
        ecdsaPublic: toBase64(ecdsa.publicKey),
      },
    ],
  })

  await issueGrantFor({
    storage: context.storage,
    groupId: context.code.groupId,
    roster: updated,
    settings: context.settings,
    userId,
  })

  return { userId }
}

/**
 * パスワードを再発行する。管理者のみ。
 *
 * 鍵ペアごと作り直す。管理者は本人の秘密鍵を取り出せない(本人のパスワードで
 * 包まれている)ので、鍵を保ったままパスワードだけ変えることは原理的にできない。
 * 古い端末に残った未送信の投函は開けなくなる。
 */
export async function reissuePassword(
  context: Context & { userId: string; loginId: string; password: string },
): Promise<void> {
  assertAdmin(context.session)

  const generation = INITIAL_GENERATION
  const { file, keys } = await openKeyring({
    storage: context.storage,
    groupId: context.code.groupId,
    generation,
    session: context.session,
  })

  const roster = await loadRosterFile({
    storage: context.storage,
    groupId: context.code.groupId,
  })
  const contents = await verifyRoster(roster, fromBase64(context.code.adminPublicKey))
  const member = contents.members.find((candidate) => candidate.userId === context.userId)
  if (!member) {
    throw new MembershipError('その人は名簿にいません')
  }

  const ecdh = await generateEcdhKeyPair()
  const ecdsa = await generateEcdsaKeyPair()

  await placeKeystore({
    storage: context.storage,
    groupId: context.code.groupId,
    loginId: context.loginId.trim().toLowerCase(),
    userId: context.userId,
    pair: { ecdh, ecdsa },
    password: context.password,
    pepper: context.code.pepper,
    kdf: context.kdf ?? PRODUCTION_KDF,
  })

  const nextKeyring = await grantScopes({
    file,
    keys,
    userId: context.userId,
    ecdhPublic: ecdh.publicKey,
    scopes: member.scopes,
    generation,
    adminUserId: context.session.userId,
    adminEcdhPublic: adminPublic(contents, context.session.userId),
  })
  await context.storage.put(
    keyringPath(context.code.groupId, generation),
    serializeKeyringFile(nextKeyring),
  )

  const updated = await reSignRoster({
    storage: context.storage,
    session: context.session,
    code: context.code,
    generation,
    change: (current) =>
      current.members.map((candidate) =>
        candidate.userId === context.userId
          ? {
              ...candidate,
              ecdhPublic: toBase64(ecdh.publicKey),
              ecdsaPublic: toBase64(ecdsa.publicKey),
            }
          : candidate,
      ),
  })

  // 古い枠はもう開けない。配り直さないと、その人は何も送れなくなる。
  await issueGrantFor({
    storage: context.storage,
    groupId: context.code.groupId,
    roster: updated,
    settings: context.settings,
    userId: context.userId,
  })
}
