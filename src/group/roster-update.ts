import type { Bytes } from '../crypto/bytes'
import type { RosterContents, RosterFile } from '../crypto/roster'
import {
  parseRosterFile,
  serializeRosterFile,
  signRoster,
  verifyRoster,
} from '../crypto/roster'
import { rosterPath } from '../storage/paths'
import type { StorageProvider } from '../storage/provider'
import type { ContactBook } from './contacts'
import { readContacts, sealContacts, withContact } from './contacts'
import type { Session } from './session'

export class RosterUpdateError extends Error {}

export interface RosterUpdateResult {
  generation: number
  contacts: ContactBook
}

export async function loadRosterFile(options: {
  storage: StorageProvider
  groupId: string
}): Promise<RosterFile> {
  try {
    return parseRosterFile(await options.storage.get(rosterPath(options.groupId)))
  } catch {
    throw new RosterUpdateError(`no roster could be read for group "${options.groupId}"`)
  }
}

/**
 * 連絡先を更新し、名簿を再署名して書き戻す。
 *
 * 再署名できるのは管理者だけ。信頼の根は接続コードの adminPublicKey で、
 * 対応する秘密鍵は管理者のキーストアにしかない。
 */
export async function updateContacts(options: {
  storage: StorageProvider
  session: Session
  adminPublicKey: Bytes
  staffKey: CryptoKey
  generation: number
  updates: Array<{ userId: string; email: string }>
}): Promise<RosterUpdateResult> {
  if (options.session.role !== 'admin') {
    throw new RosterUpdateError('only an admin can re-sign the roster')
  }

  const file = await loadRosterFile({
    storage: options.storage,
    groupId: options.session.groupId,
  })
  const contents = await verifyRoster(file, options.adminPublicKey)

  let contacts = await readContacts({ file, staffKey: options.staffKey })
  for (const update of options.updates) {
    contacts = withContact(contacts, update.userId, update.email)
  }

  const generation = contents.generation + 1
  const next: RosterContents = { ...contents, generation }
  const staffSection = await sealContacts({
    contacts,
    staffKey: options.staffKey,
    generation: options.generation,
  })
  const signed = await signRoster(next, staffSection, {
    publicKey: options.adminPublicKey,
    privateKey: options.session.ecdsaPrivate,
  })

  // 署名を誤った名簿を置くと全員がログインできなくなる。書き込む前に自分で検証する。
  try {
    await verifyRoster(signed, options.adminPublicKey)
  } catch {
    throw new RosterUpdateError(
      'the freshly signed roster does not verify; refusing to publish it',
    )
  }

  await options.storage.put(
    rosterPath(options.session.groupId),
    serializeRosterFile(signed),
  )
  return { generation, contacts }
}
