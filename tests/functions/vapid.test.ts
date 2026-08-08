import { describe, it, expect } from 'vitest'
import { buildVapidHeaders, generateVapidKeys, vapidAudience } from '../../functions/workers/src/vapid'

describe('vapidAudience', () => {
  it('is the origin of the push endpoint, because that is what the RFC signs', () => {
    expect(vapidAudience('https://fcm.googleapis.com/fcm/send/abc123')).toBe(
      'https://fcm.googleapis.com',
    )
    expect(vapidAudience('https://updates.push.services.mozilla.com/wpush/v2/xyz')).toBe(
      'https://updates.push.services.mozilla.com',
    )
  })

  it('refuses something that is not a url', async () => {
    expect(() => vapidAudience('not a url')).toThrow()
  })
})

describe('buildVapidHeaders', () => {
  it('signs a token the push service can check against the public key', async () => {
    const keys = await generateVapidKeys()
    const headers = await buildVapidHeaders({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      subject: 'mailto:admin@example.invalid',
      keys,
      now: new Date('2026-08-08T00:00:00.000Z'),
    })

    expect(headers.Authorization.startsWith('vapid t=')).toBe(true)
    expect(headers.Authorization).toContain(`k=${keys.publicKey}`)

    const token = headers.Authorization.slice('vapid t='.length).split(',')[0] as string
    const [header, payload, signature] = token.split('.')
    expect(JSON.parse(fromBase64Url(header as string))).toEqual({ typ: 'JWT', alg: 'ES256' })

    const claims = JSON.parse(fromBase64Url(payload as string))
    expect(claims.aud).toBe('https://fcm.googleapis.com')
    expect(claims.sub).toBe('mailto:admin@example.invalid')
    // 期限は12時間。RFC 8292 は24時間を上限にしている
    expect(claims.exp).toBe(Math.floor(Date.parse('2026-08-08T12:00:00.000Z') / 1000))

    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await importPublicKey(keys.publicKey),
      bytesFromBase64Url(signature as string) as unknown as ArrayBuffer,
      new TextEncoder().encode(`${header}.${payload}`),
    )
    expect(verified).toBe(true)
  })

  it('sets the ttl so a phone that is off still gets the nudge later', async () => {
    const keys = await generateVapidKeys()
    const headers = await buildVapidHeaders({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      subject: 'mailto:admin@example.invalid',
      keys,
    })
    expect(headers.TTL).toBe('86400')
    // 中身が無いことを push サービスに伝える
    expect(headers['Content-Length']).toBe('0')
  })
})

function bytesFromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function fromBase64Url(value: string): string {
  return new TextDecoder().decode(bytesFromBase64Url(value))
}

async function importPublicKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    bytesFromBase64Url(publicKey) as unknown as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  )
}
