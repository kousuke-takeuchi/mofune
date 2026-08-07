import type { Bytes } from '../crypto/bytes'
import { fromBase64, fromUtf8, utf8 } from '../crypto/bytes'
import { openEnvelopeWithKey, sealEnvelope } from '../crypto/envelope'
import { keyId } from '../crypto/keyring'
import type { RosterFile } from '../crypto/roster'
import { STAFF_SCOPE } from '../crypto/roster'

export class ContactsError extends Error {}

export interface Contact {
  email: string
}

/** userId -> 連絡先。provisionGroup が書く形と同じ。 */
export type ContactBook = Record<string, Contact>

export function staffSectionKeyId(generation: number): string {
  return keyId(STAFF_SCOPE, generation)
}

/** 連絡先を1件足すか置き換える。入力は変更しない。 */
export function withContact(
  contacts: ContactBook,
  userId: string,
  email: string,
): ContactBook {
  return { ...contacts, [userId]: { email } }
}

export async function sealContacts(options: {
  contacts: ContactBook
  staffKey: CryptoKey
  generation: number
}): Promise<Bytes> {
  return sealEnvelope(
    options.staffKey,
    staffSectionKeyId(options.generation),
    utf8(JSON.stringify(options.contacts)),
  )
}

/** 名簿の staff 部を復号する。担当者・管理者だけが持つ鍵が要る。 */
export async function readContacts(options: {
  file: RosterFile
  staffKey: CryptoKey
}): Promise<ContactBook> {
  if (options.file.staffSection === null) return {}

  let plaintext: Bytes
  try {
    plaintext = await openEnvelopeWithKey(
      options.staffKey,
      fromBase64(options.file.staffSection),
    )
  } catch {
    throw new ContactsError('the staff section could not be decrypted with this key')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(plaintext))
  } catch {
    throw new ContactsError('the staff section is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ContactsError('the staff section is not a contact book')
  }
  return parsed as ContactBook
}
