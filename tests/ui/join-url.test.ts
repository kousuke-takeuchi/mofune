import { describe, it, expect } from 'vitest'
import {
  buildJoinUrl,
  connectionCodeFromQuery,
  parseJoinLink,
  parseJoinText,
} from '../../src/group/join-url'

describe('buildJoinUrl', () => {
  it('points at the login screen of the app that is running', () => {
    expect(buildJoinUrl('CODE', 'https://mofune.site/app/')).toBe(
      'https://mofune.site/app/#/login?c=CODE',
    )
  })

  it('does not double the slash when the origin already ends with one', () => {
    expect(buildJoinUrl('CODE', 'https://mofune.site/app')).toBe(
      'https://mofune.site/app/#/login?c=CODE',
    )
  })

  it('escapes a code that would otherwise break the query', () => {
    // 接続コードは base64url なので通常は安全だが、URL に載せる以上は必ず通す
    expect(buildJoinUrl('a+b=c&d', 'https://mofune.site/app/')).toContain('a%2Bb%3Dc%26d')
  })
})

describe('connectionCodeFromQuery', () => {
  it('reads the code a QR handed over', () => {
    expect(connectionCodeFromQuery('CODE')).toBe('CODE')
  })

  it('ignores a missing or repeated parameter rather than guessing', () => {
    expect(connectionCodeFromQuery(undefined)).toBe('')
    expect(connectionCodeFromQuery(['a', 'b'])).toBe('')
  })

  it('trims the whitespace a mail client may have wrapped in', () => {
    expect(connectionCodeFromQuery('  CODE \n')).toBe('CODE')
  })
})

describe('a link that carries the whole login', () => {
  it('packs the code, the address and the first password into one parameter', () => {
    const url = buildJoinUrl('CODE', 'https://mofune.site/app/', {
      email: 'sato@example.com',
      password: 'first-pass',
    })
    // 3つ別々のパラメータにすると、1つだけ欠けた URL が回りやすい
    expect(url.startsWith('https://mofune.site/app/#/login?j=')).toBe(true)
    expect(url).not.toContain('sato@example.com')
    expect(url).not.toContain('first-pass')

    expect(parseJoinLink({ j: new URL(url).hash.split('j=')[1] as string })).toEqual({
      code: 'CODE',
      email: 'sato@example.com',
      password: 'first-pass',
    })
  })

  it('still understands the older link that carries only the code', () => {
    expect(parseJoinLink({ c: 'CODE' })).toEqual({ code: 'CODE' })
  })

  it('returns nothing when the link carries neither', () => {
    expect(parseJoinLink({})).toBeNull()
    expect(parseJoinLink({ j: 'not-base64url!!' })).toBeNull()
  })

  it('refuses a packed link that is missing a piece, rather than half-filling the form', () => {
    const half = btoa(JSON.stringify({ c: 'CODE', e: 'sato@example.com' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(parseJoinLink({ j: half })).toEqual({ code: 'CODE', email: 'sato@example.com' })
  })
})

describe('parseJoinText (what a scanner hands over)', () => {
  it('reads a link that carries the whole login', () => {
    const url = buildJoinUrl('CODE', 'https://mofune.site/app/', {
      email: 'sato@example.com',
      password: 'first-pass',
    })
    expect(parseJoinText(url)).toEqual({
      code: 'CODE',
      email: 'sato@example.com',
      password: 'first-pass',
    })
  })

  it('reads a link that carries only the code', () => {
    expect(parseJoinText('https://mofune.site/app/#/login?c=CODE')).toEqual({ code: 'CODE' })
  })

  it('takes a bare connection code, because some papers print just that', () => {
    expect(parseJoinText('  CODE-ONLY ')).toEqual({ code: 'CODE-ONLY' })
  })

  it('says nothing for a QR that has nothing to do with us', () => {
    expect(parseJoinText('https://example.com/hello')).toBeNull()
    expect(parseJoinText('   ')).toBeNull()
  })
})
