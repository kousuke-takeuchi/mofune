import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MAX_URL_LENGTH,
  MailtoError,
  buildMailBatches,
  buildMailtoUrl,
} from '../../src/notify/mailto'
import type { Recipient } from '../../src/notify/recipients'
import type { MailTemplate } from '../../src/group/group-settings'

const template: MailTemplate = {
  subject: '{{グループ名}}に新着があります',
  body: '{{グループ名}}に新しい{{種別}}が届いています。\n{{リンク}}',
}

function people(count: number): Recipient[] {
  return Array.from({ length: count }, (_, i) => ({
    userId: `u_${i}`,
    displayName: `参加者${i}`,
    email: `member${String(i).padStart(3, '0')}@example.com`,
  }))
}

const base = {
  template,
  groupName: 'みどり台グループ',
  kind: 'お知らせ',
  link: 'https://mofune.site/app/',
  to: 'group@example.com',
}

describe('buildMailtoUrl', () => {
  it('starts with the mailto scheme and the to address', () => {
    const url = buildMailtoUrl({ to: 'group@example.com', bcc: [], subject: 's', body: 'b' })
    expect(url.startsWith('mailto:group@example.com?')).toBe(true)
  })

  it('puts every recipient in bcc, never in to', () => {
    const url = buildMailtoUrl({
      to: 'group@example.com',
      bcc: ['a@example.com', 'b@example.com'],
      subject: 's',
      body: 'b',
    })
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    expect(params.get('bcc')).toBe('a@example.com,b@example.com')
    expect(url.slice(0, url.indexOf('?'))).toBe('mailto:group@example.com')
  })

  it('percent-encodes the subject and body', () => {
    const url = buildMailtoUrl({
      to: 'g@example.com',
      bcc: [],
      subject: 'みどり台 & 新着',
      body: '1行目\n2行目',
    })
    expect(url).not.toContain('みどり台')
    expect(url).not.toContain('\n')
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    expect(params.get('subject')).toBe('みどり台 & 新着')
    expect(params.get('body')).toBe('1行目\n2行目')
  })

  it('omits bcc when there is nobody to address', () => {
    const url = buildMailtoUrl({ to: 'g@example.com', bcc: [], subject: 's', body: 'b' })
    expect(url).not.toContain('bcc=')
  })
})

describe('buildMailBatches', () => {
  it('produces a single batch for a small group', () => {
    const batches = buildMailBatches({ ...base, recipients: people(5) })
    expect(batches).toHaveLength(1)
    expect(batches[0]?.recipients).toHaveLength(5)
    expect(batches[0]).toMatchObject({ index: 1, total: 1 })
  })

  it('renders the template into the subject and body', () => {
    const batches = buildMailBatches({ ...base, recipients: people(1) })
    const params = new URLSearchParams(batches[0]?.url.split('?')[1] ?? '')
    expect(params.get('subject')).toBe('みどり台グループに新着があります')
    expect(params.get('body')).toContain('新しいお知らせが届いています')
    expect(params.get('body')).toContain('https://mofune.site/app/')
  })

  it('splits when the url would be too long', () => {
    const batches = buildMailBatches({ ...base, recipients: people(200), maxUrlLength: 800 })
    expect(batches.length).toBeGreaterThan(1)
    for (const batch of batches) {
      expect(batch.url.length).toBeLessThanOrEqual(800)
    }
  })

  it('numbers the batches for the ui', () => {
    const batches = buildMailBatches({ ...base, recipients: people(200), maxUrlLength: 800 })
    expect(batches.map((b) => b.index)).toEqual(batches.map((_, i) => i + 1))
    for (const batch of batches) expect(batch.total).toBe(batches.length)
  })

  it('includes every recipient exactly once across the batches', () => {
    const recipients = people(200)
    const batches = buildMailBatches({ ...base, recipients, maxUrlLength: 800 })
    const addressed = batches.flatMap((b) => b.recipients.map((r) => r.userId))
    expect(addressed.sort()).toEqual(recipients.map((r) => r.userId).sort())
  })

  it('never puts an address in the to field', () => {
    const batches = buildMailBatches({ ...base, recipients: people(50), maxUrlLength: 900 })
    for (const batch of batches) {
      expect(batch.url.slice(0, batch.url.indexOf('?'))).toBe('mailto:group@example.com')
    }
  })

  it('returns nothing when there is nobody to notify', () => {
    expect(buildMailBatches({ ...base, recipients: [] })).toEqual([])
  })

  it('refuses a url budget too small to fit even a few addresses', () => {
    expect(() =>
      buildMailBatches({ ...base, recipients: people(10), maxUrlLength: 50 }),
    ).toThrow(MailtoError)
  })

  it('has a conservative default budget', () => {
    // 実機未検証の値。検証課題 §16-1 が終わるまで「正しい」とみなさない
    expect(DEFAULT_MAX_URL_LENGTH).toBeGreaterThan(0)
    expect(DEFAULT_MAX_URL_LENGTH).toBeLessThanOrEqual(2000)
  })

  it('does not put the message body into the mail', () => {
    const batches = buildMailBatches({
      ...base,
      recipients: people(1),
      template: { subject: '{{グループ名}}', body: '{{本文}}' },
    })
    const params = new URLSearchParams(batches[0]?.url.split('?')[1] ?? '')
    // 未知のプレースホルダは置換されず、そのまま残る
    expect(params.get('body')).toBe('{{本文}}')
  })
})
