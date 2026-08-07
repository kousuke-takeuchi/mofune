import type { Bytes } from '../crypto/bytes'
import { fromBase64 } from '../crypto/bytes'
import { parseKeyringFile, unlockKeyring } from '../crypto/keyring'
import type { KeystoreContents } from '../crypto/keystore'
import { InvalidPasswordError, parseKeystoreFile, unlockKeystore } from '../crypto/keystore'
import type { Role, RosterContents } from '../crypto/roster'
import { parseRosterFile, verifyRoster } from '../crypto/roster'
import type { StorageProvider } from '../storage/provider'
import { NotFoundError } from '../storage/provider'
import { keyringPath, keystorePath, manifestPath, rosterPath } from '../storage/paths'
import type { ConnectionCode } from './connection-code'
import { decodeManifest } from './manifest'

export class LoginError extends Error {}

/** アカウント不存在とパスワード誤りを区別させないための共通メッセージ。 */
const CREDENTIALS_MESSAGE = 'ログインIDまたはパスワードが正しくありません'

export interface Session {
  groupId: string
  groupName: string
  userId: string
  displayName: string
  role: Role
  scopes: string[]
  /** keyId -> グループ鍵 */
  groupKeys: Map<string, CryptoKey>
  roster: RosterContents
  ecdhPrivate: Bytes
  ecdsaPrivate: Bytes
}

export interface LoginOptions {
  code: ConnectionCode
  loginId: string
  password: string
  storage: StorageProvider
}

async function loadKeystore(options: LoginOptions): Promise<KeystoreContents> {
  const path = await keystorePath(options.code.groupId, options.loginId)
  let bytes: Bytes
  try {
    bytes = await options.storage.get(path)
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new LoginError(CREDENTIALS_MESSAGE)
    }
    throw error
  }
  try {
    return await unlockKeystore(
      parseKeystoreFile(bytes),
      options.password,
      options.code.pepper,
    )
  } catch (error) {
    if (error instanceof InvalidPasswordError) {
      throw new LoginError(CREDENTIALS_MESSAGE)
    }
    throw error
  }
}

export async function login(options: LoginOptions): Promise<Session> {
  const { code, storage } = options

  const manifest = decodeManifest(await storage.get(manifestPath(code.groupId)))
  if (manifest.groupId !== code.groupId) {
    throw new LoginError(
      `manifest group "${manifest.groupId}" does not match the connection code`,
    )
  }

  const keystore = await loadKeystore(options)

  // 名簿は接続コードが運ぶ Admin 公開鍵でのみ検証する。
  let roster: RosterContents
  try {
    roster = await verifyRoster(
      parseRosterFile(await storage.get(rosterPath(code.groupId))),
      fromBase64(code.adminPublicKey),
    )
  } catch (error) {
    throw new LoginError(
      `名簿を検証できませんでした: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const member = roster.members.find((candidate) => candidate.userId === keystore.userId)
  if (!member) {
    throw new LoginError('このアカウントは名簿に登録されていません')
  }

  const keyring = parseKeyringFile(
    await storage.get(keyringPath(code.groupId, manifest.keyringGeneration)),
  )
  const groupKeys = await unlockKeyring(keyring, keystore.userId, keystore.ecdh.privateKey)

  return {
    groupId: code.groupId,
    groupName: manifest.groupName,
    userId: keystore.userId,
    displayName: member.displayName,
    role: member.role,
    scopes: member.scopes,
    groupKeys,
    roster,
    ecdhPrivate: keystore.ecdh.privateKey,
    ecdsaPrivate: keystore.ecdsa.privateKey,
  }
}
