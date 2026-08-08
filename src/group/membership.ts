import { generateEcdhKeyPair, generateEcdsaKeyPair } from '../crypto/asymmetric'
import type { RawKeyPair } from '../crypto/asymmetric'
import { fromBase64, toBase64, toHex } from '../crypto/bytes'
import type { KdfParams } from '../crypto/kdf'
import { PRODUCTION_KDF } from '../crypto/kdf'
import { createKeystore, serializeKeystoreFile } from '../crypto/keystore'
import type { Role } from '../crypto/roster'
import { resolveScopes, verifyRoster } from '../crypto/roster'
import { randomBytes } from '../crypto/symmetric'
import { keyringPath, keystorePath } from '../storage/paths'
import { serializeKeyringFile } from '../crypto/keyring'
import type { StorageProvider } from '../storage/provider'
import type { ConnectionCode } from './connection-code'
import { INITIAL_GENERATION } from './provision'
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

export class MembershipError extends Error {}

// 名簿と鍵束の書き換えは roster-writer が受け持つ

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
  assertAdmin(context.session, MembershipError)

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
  assertAdmin(context.session, MembershipError)

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
