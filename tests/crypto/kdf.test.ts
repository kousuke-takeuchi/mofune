import { describe, it, expect } from 'vitest'
import { PRODUCTION_KDF, TEST_KDF, SALT_BYTES, deriveKek } from '../../src/crypto/kdf'
import { exportAesKey, randomBytes } from '../../src/crypto/symmetric'
import { toHex } from '../../src/crypto/bytes'

const salt = randomBytes(SALT_BYTES)

describe('kdf', () => {
  it('derives a 32-byte AES key', async () => {
    const key = await deriveKek('correct horse', 'pepper', salt, TEST_KDF)
    expect(await exportAesKey(key)).toHaveLength(32)
  })

  it('is deterministic for the same inputs', async () => {
    const a = await deriveKek('pass', 'pepper', salt, TEST_KDF)
    const b = await deriveKek('pass', 'pepper', salt, TEST_KDF)
    expect(toHex(await exportAesKey(a))).toBe(toHex(await exportAesKey(b)))
  })

  it('produces a different key for a different password', async () => {
    const a = await deriveKek('pass', 'pepper', salt, TEST_KDF)
    const b = await deriveKek('Pass', 'pepper', salt, TEST_KDF)
    expect(toHex(await exportAesKey(a))).not.toBe(toHex(await exportAesKey(b)))
  })

  it('produces a different key for a different pepper', async () => {
    const a = await deriveKek('pass', 'pepper-a', salt, TEST_KDF)
    const b = await deriveKek('pass', 'pepper-b', salt, TEST_KDF)
    expect(toHex(await exportAesKey(a))).not.toBe(toHex(await exportAesKey(b)))
  })

  it('produces a different key for a different salt', async () => {
    const a = await deriveKek('pass', 'pepper', randomBytes(SALT_BYTES), TEST_KDF)
    const b = await deriveKek('pass', 'pepper', randomBytes(SALT_BYTES), TEST_KDF)
    expect(toHex(await exportAesKey(a))).not.toBe(toHex(await exportAesKey(b)))
  })

  it('cannot be fooled by moving the boundary between password and pepper', async () => {
    const a = await deriveKek('ab', 'c', salt, TEST_KDF)
    const b = await deriveKek('a', 'bc', salt, TEST_KDF)
    expect(toHex(await exportAesKey(a))).not.toBe(toHex(await exportAesKey(b)))
  })

  it('rejects a salt shorter than 8 bytes', async () => {
    await expect(deriveKek('pass', 'pepper', randomBytes(4), TEST_KDF)).rejects.toThrow(
      /salt/,
    )
  })

  it('uses at least 64 MiB of memory in production parameters', () => {
    expect(PRODUCTION_KDF.memorySize).toBeGreaterThanOrEqual(65536)
    expect(PRODUCTION_KDF.algorithm).toBe('argon2id')
  })
})
