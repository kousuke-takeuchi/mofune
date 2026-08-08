import { describe, it, expect } from 'vitest'
import { belongsToShell } from '../../src/sw/cache-policy'

const APP = 'https://mofune.site/app/'

describe('belongsToShell', () => {
  it('takes the files that make up the app itself', () => {
    for (const url of [
      'https://mofune.site/app/',
      'https://mofune.site/app/index.html',
      'https://mofune.site/app/assets/index-abc123.js',
      'https://mofune.site/app/assets/index-abc123.css',
      'https://mofune.site/app/manifest.webmanifest',
      'https://mofune.site/app/icon-192.png',
      'https://mofune.site/fonts/noto-sans-jp-400.woff2',
    ]) {
      expect(belongsToShell(url, APP)).toBe(true)
    }
  })

  it('leaves the group data alone', () => {
    // 保管場所のデータを勝手に持たないのが肝心。中身が端末に増えるうえ、
    // 古いものを配ってしまう。
    for (const url of [
      'https://pub-1234.r2.dev/g_1/events-index.json',
      'https://pub-1234.r2.dev/g_1/messages/m_1.enc',
      'https://account.r2.cloudflarestorage.com/mofune/g_1/inbox/u_1/x.enc',
    ]) {
      expect(belongsToShell(url, APP)).toBe(false)
    }
  })

  it('leaves the introduction site alone', () => {
    // 紹介ページは別物。アプリの殻として持つ理由がない。
    expect(belongsToShell('https://mofune.site/', APP)).toBe(false)
    expect(belongsToShell('https://mofune.site/setup-guide.html', APP)).toBe(false)
  })

  it('does not choke on something that is not a url', () => {
    expect(belongsToShell('not a url', APP)).toBe(false)
  })
})
