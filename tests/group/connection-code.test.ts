import { describe, it, expect } from 'vitest'
import {
  ConnectionCodeError,
  encodeConnectionCode,
  decodeConnectionCode,
} from '../../src/group/connection-code'
import type { ConnectionCode } from '../../src/group/connection-code'
import { toBase64Url, utf8 } from '../../src/crypto/bytes'

const code: ConnectionCode = {
  v: 1,
  groupId: 'midori',
  provider: 's3',
  root: 'https://example.invalid/mofune',
  pepper: 'cGVwcGVy',
  adminPublicKey: 'BAAA',
}

describe('connection code', () => {
  it('round-trips a code', () => {
    expect(decodeConnectionCode(encodeConnectionCode(code))).toEqual(code)
  })

  it('produces a URL-safe string', () => {
    expect(encodeConnectionCode(code)).not.toMatch(/[+/=]/)
  })

  it('tolerates surrounding whitespace from a paper transcription', () => {
    expect(decodeConnectionCode(`  ${encodeConnectionCode(code)}\n`)).toEqual(code)
  })

  it('rejects text that is not valid base64url JSON', () => {
    expect(() => decodeConnectionCode('not-a-code!!')).toThrow(ConnectionCodeError)
  })

  it('rejects an unknown version', () => {
    const bad = toBase64Url(utf8(JSON.stringify({ ...code, v: 99 })))
    expect(() => decodeConnectionCode(bad)).toThrow(/version/)
  })

  it('rejects an unknown provider', () => {
    const bad = toBase64Url(utf8(JSON.stringify({ ...code, provider: 'ftp' })))
    expect(() => decodeConnectionCode(bad)).toThrow(/provider/)
  })

  it('rejects a code missing the admin public key', () => {
    const bad = toBase64Url(utf8(JSON.stringify({ ...code, adminPublicKey: '' })))
    expect(() => decodeConnectionCode(bad)).toThrow(ConnectionCodeError)
  })
})
