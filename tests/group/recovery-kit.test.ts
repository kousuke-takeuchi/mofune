import { describe, it, expect } from 'vitest'
import { RecoveryKitError, buildRecoveryKit, parseRecoveryKit } from '../../src/group/recovery-kit'
import { generateEcdhKeyPair, generateEcdsaKeyPair } from '../../src/crypto/asymmetric'
import { toHex } from '../../src/crypto/bytes'
import type { KeystoreContents } from '../../src/crypto/keystore'

async function contents(): Promise<KeystoreContents> {
  return {
    userId: 'u_0123456789abcdef',
    ecdh: await generateEcdhKeyPair(),
    ecdsa: await generateEcdsaKeyPair(),
  }
}

const meta = { groupId: 'midori', groupName: 'みどり台グループ' }

describe('buildRecoveryKit', () => {
  it('carries the group and user it belongs to', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    expect(kit.groupId).toBe('midori')
    expect(kit.groupName).toBe('みどり台グループ')
    expect(kit.userId).toBe('u_0123456789abcdef')
  })

  it('prints the code in readable groups', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    expect(kit.code).toContain('-')
    expect(kit.code).toContain('\n')
  })

  it('includes a checksum', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    expect(kit.checksum.length).toBeGreaterThan(0)
  })

  it('produces a different code for a different key', async () => {
    const a = await buildRecoveryKit({ ...meta, contents: await contents() })
    const b = await buildRecoveryKit({ ...meta, contents: await contents() })
    expect(a.code).not.toBe(b.code)
  })
})

describe('parseRecoveryKit', () => {
  it('restores the exact key material', async () => {
    const original = await contents()
    const kit = await buildRecoveryKit({ ...meta, contents: original })
    const restored = await parseRecoveryKit(kit.code)
    expect(restored.userId).toBe(original.userId)
    expect(toHex(restored.contents.ecdsa.privateKey)).toBe(toHex(original.ecdsa.privateKey))
    expect(toHex(restored.contents.ecdsa.publicKey)).toBe(toHex(original.ecdsa.publicKey))
    expect(toHex(restored.contents.ecdh.privateKey)).toBe(toHex(original.ecdh.privateKey))
    expect(toHex(restored.contents.ecdh.publicKey)).toBe(toHex(original.ecdh.publicKey))
  })

  it('restores the group it belongs to', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    expect((await parseRecoveryKit(kit.code)).groupId).toBe('midori')
  })

  it('accepts a code typed without the separators', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    const flat = kit.code.replace(/[-\s]/g, '')
    expect((await parseRecoveryKit(flat)).groupId).toBe('midori')
  })

  it('accepts a code typed in lower case', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    expect((await parseRecoveryKit(kit.code.toLowerCase())).groupId).toBe('midori')
  })

  it('rejects a code with a mistyped character', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    const flat = kit.code.replace(/[-\s]/g, '')
    // 1文字だけ別の記号に置き換える
    const broken = (flat[0] === '2' ? '3' : '2') + flat.slice(1)
    await expect(parseRecoveryKit(broken)).rejects.toThrow(RecoveryKitError)
  })

  it('rejects a truncated code', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    const flat = kit.code.replace(/[-\s]/g, '')
    await expect(parseRecoveryKit(flat.slice(0, -8))).rejects.toThrow(RecoveryKitError)
  })

  it('rejects text that is not a recovery kit', async () => {
    await expect(parseRecoveryKit('HELLO')).rejects.toThrow(RecoveryKitError)
  })

  it('rejects an empty code', async () => {
    await expect(parseRecoveryKit('')).rejects.toThrow(RecoveryKitError)
  })
})
