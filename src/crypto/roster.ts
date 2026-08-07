import type { Bytes } from './bytes'
import type { RawKeyPair } from './asymmetric'
import { sign, verify } from './asymmetric'
import { concat, equal, fromBase64, fromUtf8, toBase64, utf8 } from './bytes'

export class RosterVerificationError extends Error {}
export class RosterFormatError extends Error {}

export const ROSTER_VERSION = 1

/** グループ全体。全メンバーが持つ。 */
export const ALL_SCOPE = 'all'
/** 担当者のみ。連絡先の封緘に使う。 */
export const STAFF_SCOPE = 'staff'

export type Role = 'admin' | 'staff' | 'member'

export interface Subgroup {
  id: string
  name: string
  /** 親サブグループの id。トップレベルは null。 */
  parent: string | null
}

export interface RosterMember {
  userId: string
  displayName: string
  role: Role
  scopes: string[]
  /** base64, raw ECDH public key */
  ecdhPublic: string
  /** base64, raw ECDSA public key */
  ecdsaPublic: string
}

export interface RosterContents {
  groupId: string
  generation: number
  subgroups: Subgroup[]
  members: RosterMember[]
}

/**
 * 末端の所属から完全なスコープ集合を作る。祖先サブグループと all、
 * admin/staff には staff を加える。返り値は昇順で重複なし。
 * 木は所属の伝播にのみ使い、鍵の派生には使わない(設計書 §3.2)。
 */
export function resolveScopes(
  subgroups: Subgroup[],
  role: Role,
  scopes: string[],
): string[] {
  const byId = new Map(subgroups.map((subgroup) => [subgroup.id, subgroup]))
  const resolved = new Set<string>([ALL_SCOPE])
  if (role === 'admin' || role === 'staff') {
    resolved.add(STAFF_SCOPE)
  }
  for (const scope of scopes) {
    let current = byId.get(scope)
    if (!current) {
      throw new RosterVerificationError(`unknown subgroup "${scope}"`)
    }
    const seen = new Set<string>()
    while (current) {
      if (seen.has(current.id)) {
        throw new RosterVerificationError(`subgroup tree has a cycle at "${current.id}"`)
      }
      seen.add(current.id)
      resolved.add(current.id)
      if (current.parent === null) break
      const parent = byId.get(current.parent)
      if (!parent) {
        throw new RosterVerificationError(`unknown parent subgroup "${current.parent}"`)
      }
      current = parent
    }
  }
  return [...resolved].sort()
}

export interface RosterFile {
  v: number
  /** base64 of the canonical contents */
  contents: string
  /** base64 のエンベロープ。staff スコープ鍵で暗号化された連絡先。 */
  staffSection: string | null
  /** base64 */
  signature: string
  /** base64。接続コード側の鍵と一致することを必ず確認する。 */
  adminPublicKey: string
}

/**
 * 署名対象を安定させるための正規形。サブグループは id 昇順、メンバーは userId 昇順、
 * scopes も昇順に並べ替え、キーの出現順を固定する。
 */
export function canonicalize(contents: RosterContents): Bytes {
  const subgroups = [...contents.subgroups]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((subgroup) => ({
      id: subgroup.id,
      name: subgroup.name,
      parent: subgroup.parent,
    }))
  const members = [...contents.members]
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    .map((member) => ({
      userId: member.userId,
      displayName: member.displayName,
      role: member.role,
      scopes: [...member.scopes].sort(),
      ecdhPublic: member.ecdhPublic,
      ecdsaPublic: member.ecdsaPublic,
    }))
  return utf8(
    JSON.stringify({
      groupId: contents.groupId,
      generation: contents.generation,
      subgroups,
      members,
    }),
  )
}

/** contents と staffSection の両方を署名対象に含める。区切りの "." で境界を固定する。 */
function signedBytes(contentsBase64: string, staffSection: string | null): Bytes {
  return concat(utf8(contentsBase64), utf8('.'), utf8(staffSection ?? ''))
}

export async function signRoster(
  contents: RosterContents,
  staffSection: Bytes | null,
  adminEcdsa: RawKeyPair,
): Promise<RosterFile> {
  const contentsBase64 = toBase64(canonicalize(contents))
  const staffBase64 = staffSection ? toBase64(staffSection) : null
  const signature = await sign(
    adminEcdsa.privateKey,
    signedBytes(contentsBase64, staffBase64),
  )
  return {
    v: ROSTER_VERSION,
    contents: contentsBase64,
    staffSection: staffBase64,
    signature: toBase64(signature),
    adminPublicKey: toBase64(adminEcdsa.publicKey),
  }
}

export async function verifyRoster(
  file: RosterFile,
  trustedAdminPublicKey: Bytes,
): Promise<RosterContents> {
  if (file.v !== ROSTER_VERSION) {
    throw new RosterVerificationError(`unsupported roster version ${String(file.v)}`)
  }
  if (!equal(fromBase64(file.adminPublicKey), trustedAdminPublicKey)) {
    throw new RosterVerificationError(
      'roster admin key does not match the key from the connection code',
    )
  }
  const valid = await verify(
    trustedAdminPublicKey,
    fromBase64(file.signature),
    signedBytes(file.contents, file.staffSection),
  )
  if (!valid) {
    throw new RosterVerificationError('roster signature is invalid')
  }
  return JSON.parse(fromUtf8(fromBase64(file.contents))) as RosterContents
}

export function serializeRosterFile(file: RosterFile): Bytes {
  return utf8(JSON.stringify(file))
}

export function parseRosterFile(bytes: Bytes): RosterFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new RosterFormatError('roster is not valid JSON')
  }
  const file = parsed as RosterFile
  if (file === null || typeof file !== 'object') {
    throw new RosterFormatError('roster is not an object')
  }
  if (
    typeof file.contents !== 'string' ||
    typeof file.signature !== 'string' ||
    typeof file.adminPublicKey !== 'string'
  ) {
    throw new RosterFormatError('roster is missing required fields')
  }
  return file
}
