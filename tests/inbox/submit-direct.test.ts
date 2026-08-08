import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { submitDirectly } from '../../src/inbox/submit'
import { openAsRecipient } from '../../src/inbox/uplink'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { flushOutbox } from '../../src/sync/outbox'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { fromUtf8, toBase64, utf8 } from '../../src/crypto/bytes'
import type { Bytes } from '../../src/crypto/bytes'
import type { RawKeyPair } from '../../src/crypto/asymmetric'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

async function fixture(): Promise<{ session: Session; admin: RawKeyPair; staff: RawKeyPair }> {
  const admin = await generateEcdhKeyPair()
  const staff = await generateEcdhKeyPair()
  const roster: RosterContents = {
    groupId: 'midori',
    generation: 1,
    subgroups: [],
    members: [
      {
        userId: 'u_admin',
        displayName: '渡辺 けい',
        role: 'admin',
        scopes: [],
        ecdhPublic: toBase64(admin.publicKey),
        ecdsaPublic: '',
      },
      {
        userId: 'u_staff',
        displayName: '田中 みか',
        role: 'staff',
        scopes: [],
        ecdhPublic: toBase64(staff.publicKey),
        ecdsaPublic: '',
      },
    ],
  }
  const session = {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_admin',
    displayName: '渡辺 けい',
    role: 'admin',
    scopes: [],
    groupKeys: new Map(),
    generation: 1,
    roster,
    ecdhPrivate: admin.privateKey,
    ecdsaPrivate: new Uint8Array(0) as Bytes,
  } as unknown as Session
  return { session, admin, staff }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('submitDirectly', () => {
  it('lets someone with write credentials post without a grant', async () => {
    // 投函枠は参加者にしか配られない。担当者・管理者は資格情報を持つので、
    // 枠を待たずに自分で書ける。要件書 §3 は不在連絡を全ロールに認めている。
    const { session } = await fixture()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()

    const { key } = await submitDirectly({ session, db, plaintext: utf8('こんにちは') as Bytes })
    await flushOutbox({ db, storage })

    expect(key.startsWith('midori/inbox/u_admin/')).toBe(true)
    expect(await storage.list('midori/inbox/u_admin/')).toHaveLength(1)
  })

  it('seals the report so only the staff can read it', async () => {
    const { session, staff } = await fixture()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()

    const { key } = await submitDirectly({ session, db, plaintext: utf8('体調不良です') as Bytes })
    await flushOutbox({ db, storage })

    const opened = await openAsRecipient('u_staff', staff.privateKey, await storage.get(key))
    expect(fromUtf8(opened)).toBe('体調不良です')
  })
})
