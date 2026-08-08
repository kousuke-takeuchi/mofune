import { describe, it, expect } from 'vitest'
import { buildJoinUrl, connectionCodeFromQuery } from '../../src/group/join-url'

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
