import type { Bytes } from '../crypto/bytes'
import { generateEcdhKeyPair, generateEcdsaKeyPair } from '../crypto/asymmetric'
import { toBase64, toHex, utf8 } from '../crypto/bytes'
import { sealEnvelope } from '../crypto/envelope'
import type { KdfParams } from '../crypto/kdf'
import { PRODUCTION_KDF } from '../crypto/kdf'
import { createKeystore, serializeKeystoreFile } from '../crypto/keystore'
import type { KeyringEntry, KeyringFile, WrappedKey } from '../crypto/keyring'
import { KEYRING_VERSION, keyId, serializeKeyringFile, wrapKey } from '../crypto/keyring'
import type { Role, RosterMember, Subgroup } from '../crypto/roster'
import { STAFF_SCOPE, resolveScopes, serializeRosterFile, signRoster } from '../crypto/roster'
import { generateAesKey, randomBytes } from '../crypto/symmetric'
import type { StorageProvider } from '../storage/provider'
import { keyringPath, keystorePath, manifestPath, rosterPath } from '../storage/paths'
import type { ConnectionCode, ProviderKind } from './connection-code'
import { normalizeEmail } from './email-id'
import { CONNECTION_CODE_VERSION } from './connection-code'
import type { Manifest } from './manifest'
import { MANIFEST_VERSION, encodeManifest } from './manifest'

export const INITIAL_GENERATION = 1
export const STAFF_SECTION_KEY_ID = keyId(STAFF_SCOPE, INITIAL_GENERATION)

export class ProvisionError extends Error {}

export interface NewMember {
  displayName: string
  role: Role
  /** 末端のサブグループ id のみ。all・祖先・staff は resolveScopes が付ける。 */
  scopes: string[]
  password: string
  /** ログインの識別子でもある。 */
  email: string
}

export interface ProvisionOptions {
  groupId: string
  groupName: string
  provider: ProviderKind
  root: string
  subgroups: Subgroup[]
  members: NewMember[]
  kdf?: KdfParams
}

export interface ProvisionResult {
  code: ConnectionCode
  /** ストレージパス -> 書き込むバイト列 */
  objects: Map<string, Bytes>
}

export async function provisionGroup(options: ProvisionOptions): Promise<ProvisionResult> {
  const admins = options.members.filter((member) => member.role === 'admin')
  if (admins.length !== 1) {
    throw new ProvisionError(
      `a group needs exactly one admin, got ${admins.length}`,
    )
  }
  const emails = options.members.map((member) => normalizeEmail(member.email))
  if (new Set(emails).size !== emails.length) {
    throw new ProvisionError('member list contains duplicate email addresses')
  }

  const kdf = options.kdf ?? PRODUCTION_KDF
  const pepper = toBase64(randomBytes(16))
  const objects = new Map<string, Bytes>()

  // 1. メンバーごとに鍵ペアと userId を作り、キーストアを封緘する
  const prepared = await Promise.all(
    options.members.map(async (member) => {
      const ecdh = await generateEcdhKeyPair()
      const ecdsa = await generateEcdsaKeyPair()
      const userId = `u_${toHex(randomBytes(8))}`
      return {
        member,
        ecdh,
        ecdsa,
        userId,
        scopes: resolveScopes(options.subgroups, member.role, member.scopes),
      }
    }),
  )

  for (const entry of prepared) {
    const keystore = await createKeystore(
      { userId: entry.userId, ecdh: entry.ecdh, ecdsa: entry.ecdsa },
      entry.member.password,
      pepper,
      kdf,
    )
    objects.set(
      await keystorePath(options.groupId, entry.member.email),
      serializeKeystoreFile(keystore),
    )
  }

  // 2. スコープごとにグループ鍵を作り、所属メンバー宛にラップする
  const scopes = [...new Set(prepared.flatMap((entry) => entry.scopes))].sort()
  const groupKeys = new Map<string, CryptoKey>()
  const keyringEntries: Record<string, KeyringEntry> = {}

  for (const scope of scopes) {
    const groupKey = await generateAesKey()
    groupKeys.set(scope, groupKey)
    const wrapped: Record<string, WrappedKey> = {}
    for (const entry of prepared) {
      if (!entry.scopes.includes(scope)) continue
      wrapped[entry.userId] = await wrapKey(entry.ecdh.publicKey, groupKey)
    }
    keyringEntries[keyId(scope, INITIAL_GENERATION)] = {
      scope,
      generation: INITIAL_GENERATION,
      wrapped,
    }
  }

  const keyring: KeyringFile = {
    v: KEYRING_VERSION,
    generation: INITIAL_GENERATION,
    keys: keyringEntries,
  }
  objects.set(
    keyringPath(options.groupId, INITIAL_GENERATION),
    serializeKeyringFile(keyring),
  )

  // 3. 連絡先はstaff スコープ鍵で封緘する(参加者からは復号できない)
  const contacts: Record<string, { email: string }> = {}
  for (const entry of prepared) {
    contacts[entry.userId] = { email: entry.member.email }
  }
  const staffKey = groupKeys.get(STAFF_SCOPE)
  if (!staffKey) {
    throw new ProvisionError('staff scope key was not created')
  }
  const staffSection = await sealEnvelope(
    staffKey,
    STAFF_SECTION_KEY_ID,
    utf8(JSON.stringify(contacts)),
  )

  // 4. 名簿を Admin の ECDSA 鍵で署名する
  const members: RosterMember[] = prepared.map((entry) => ({
    userId: entry.userId,
    displayName: entry.member.displayName,
    role: entry.member.role,
    scopes: entry.scopes,
    ecdhPublic: toBase64(entry.ecdh.publicKey),
    ecdsaPublic: toBase64(entry.ecdsa.publicKey),
  }))
  const adminEntry = prepared.find((entry) => entry.member.role === 'admin')
  if (!adminEntry) {
    throw new ProvisionError('admin entry disappeared during provisioning')
  }
  const rosterFile = await signRoster(
    {
      groupId: options.groupId,
      generation: INITIAL_GENERATION,
      subgroups: options.subgroups,
      members,
    },
    staffSection,
    adminEntry.ecdsa,
  )
  objects.set(rosterPath(options.groupId), serializeRosterFile(rosterFile))

  // 5. manifest(唯一の平文メタデータ)
  const manifest: Manifest = {
    v: MANIFEST_VERSION,
    groupId: options.groupId,
    groupName: options.groupName,
    keyringGeneration: INITIAL_GENERATION,
    rosterGeneration: INITIAL_GENERATION,
    functionUrl: null,
    notificationChannels: ['mailto'],
  }
  objects.set(manifestPath(options.groupId), encodeManifest(manifest))

  return {
    code: {
      v: CONNECTION_CODE_VERSION,
      groupId: options.groupId,
      provider: options.provider,
      root: options.root,
      pepper,
      adminPublicKey: toBase64(adminEntry.ecdsa.publicKey),
    },
    objects,
  }
}

export async function writeObjects(
  storage: StorageProvider,
  objects: Map<string, Bytes>,
): Promise<void> {
  for (const [path, data] of objects) {
    await storage.put(path, data)
  }
}
