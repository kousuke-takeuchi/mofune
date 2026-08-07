import { describe, it, expect } from 'vitest'
import {
  ContactsError,
  readContacts,
  sealContacts,
  staffSectionKeyId,
  withContact,
} from '../../src/group/contacts'
import type { ContactBook } from '../../src/group/contacts'
import type { RosterFile } from '../../src/crypto/roster'
import { generateAesKey } from '../../src/crypto/symmetric'
import { toBase64 } from '../../src/crypto/bytes'

const contacts: ContactBook = {
  u_sato: { email: 'sakura@example.com' },
  u_mori: { email: 'yui@example.com' },
}

function fileWith(staffSection: string | null): RosterFile {
  return {
    v: 1,
    contents: 'x',
    staffSection,
    signature: 'x',
    adminPublicKey: 'x',
  }
}

describe('staffSectionKeyId', () => {
  it('is the staff scope at the given generation', () => {
    expect(staffSectionKeyId(1)).toBe('staff:v1')
    expect(staffSectionKeyId(3)).toBe('staff:v3')
  })
})

describe('withContact', () => {
  it('adds a new address', () => {
    expect(withContact({}, 'u_sato', 'sakura@example.com')).toEqual({
      u_sato: { email: 'sakura@example.com' },
    })
  })

  it('replaces an existing address', () => {
    const updated = withContact(contacts, 'u_sato', 'new@example.com')
    expect(updated['u_sato']?.email).toBe('new@example.com')
  })

  it('leaves the other entries alone', () => {
    const updated = withContact(contacts, 'u_sato', 'new@example.com')
    expect(updated['u_mori']?.email).toBe('yui@example.com')
  })

  it('does not mutate its input', () => {
    withContact(contacts, 'u_sato', 'new@example.com')
    expect(contacts['u_sato']?.email).toBe('sakura@example.com')
  })
})

describe('sealContacts / readContacts', () => {
  it('round-trips the contact book', async () => {
    const staffKey = await generateAesKey()
    const sealed = await sealContacts({ contacts, staffKey, generation: 1 })
    const file = fileWith(toBase64(sealed))
    expect(await readContacts({ file, staffKey })).toEqual(contacts)
  })

  it('does not leave any address in the ciphertext', async () => {
    const staffKey = await generateAesKey()
    const sealed = await sealContacts({ contacts, staffKey, generation: 1 })
    expect(new TextDecoder().decode(sealed)).not.toContain('sakura@example.com')
  })

  it('cannot be read with a different key', async () => {
    const sealed = await sealContacts({ contacts, staffKey: await generateAesKey(), generation: 1 })
    const file = fileWith(toBase64(sealed))
    await expect(readContacts({ file, staffKey: await generateAesKey() })).rejects.toThrow(
      ContactsError,
    )
  })

  it('treats a roster with no staff section as an empty book', async () => {
    const staffKey = await generateAesKey()
    expect(await readContacts({ file: fileWith(null), staffKey })).toEqual({})
  })

  it('reports a staff section that is not a contact book', async () => {
    const staffKey = await generateAesKey()
    const { sealEnvelope } = await import('../../src/crypto/envelope')
    const { utf8 } = await import('../../src/crypto/bytes')
    const bogus = await sealEnvelope(staffKey, 'staff:v1', utf8('"not an object"'))
    await expect(readContacts({ file: fileWith(toBase64(bogus)), staffKey })).rejects.toThrow(
      ContactsError,
    )
  })

  it('reads back what provisionGroup wrote', async () => {
    // 開設時の形を変えると既存グループが読めなくなるので、実物で確かめる
    const { provisionGroup } = await import('../../src/group/provision')
    const { parseRosterFile } = await import('../../src/crypto/roster')
    const { parseKeystoreFile, unlockKeystore } = await import('../../src/crypto/keystore')
    const { parseKeyringFile, unlockKeyring } = await import('../../src/crypto/keyring')
    const { rosterPath, keyringPath, keystorePath } = await import('../../src/storage/paths')
    const { TEST_KDF } = await import('../../src/crypto/kdf')

    const result = await provisionGroup({
      groupId: 'midori',
      groupName: 'みどり台グループ',
      provider: 'http',
      root: 'https://example.invalid/mofune',
      kdf: TEST_KDF,
      subgroups: [],
      members: [
        {
          loginId: 'watanabe',
          displayName: '渡辺 けい',
          role: 'admin',
          scopes: [],
          password: 'admin-pass',
          email: 'watanabe@example.invalid',
        },
      ],
    })
    const file = parseRosterFile(result.objects.get(rosterPath('midori')) as never)
    const keystore = await unlockKeystore(
      parseKeystoreFile(result.objects.get(await keystorePath('midori', 'watanabe')) as never),
      'admin-pass',
      result.code.pepper,
    )
    const keyring = parseKeyringFile(result.objects.get(keyringPath('midori', 1)) as never)
    const keys = await unlockKeyring(keyring, keystore.userId, keystore.ecdh.privateKey)
    const staffKey = keys.get('staff:v1') as CryptoKey

    const book = await readContacts({ file, staffKey })
    expect(Object.values(book).map((c) => c.email)).toContain('watanabe@example.invalid')
  })
})
