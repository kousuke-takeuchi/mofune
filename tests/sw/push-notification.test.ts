import { describe, it, expect } from 'vitest'
import { chooseClient, notificationContent } from '../../src/sw/push-notification'

describe('notificationContent', () => {
  it('says there is something new without saying what', () => {
    const { title, options } = notificationContent()
    expect(title).toBe('Mofune')
    expect(options.body).toBe('新しい連絡があります')
    // 通知は平文の経路。本文も差出人もここへ出さない (要件書 §4.5)
    expect(JSON.stringify(options)).not.toContain('お知らせ本文')
  })

  it('collapses repeats into one line, so a busy day is not a wall of notifications', () => {
    expect(notificationContent().options.tag).toBe('mofune-new')
    expect(notificationContent().options.renotify).toBe(true)
  })
})

describe('chooseClient', () => {
  const appUrl = 'https://mofune.site/app/'

  it('picks a window that already has the app open', () => {
    const found = chooseClient(
      [
        { url: 'https://mofune.site/', focus: () => {} },
        { url: 'https://mofune.site/app/#/g/g_1', focus: () => {} },
      ],
      appUrl,
    )
    expect(found?.url).toBe('https://mofune.site/app/#/g/g_1')
  })

  it('returns nothing when only other pages are open, so a new window is opened', () => {
    expect(chooseClient([{ url: 'https://example.invalid/', focus: () => {} }], appUrl)).toBeNull()
  })

  it('returns nothing when no window is open at all', () => {
    expect(chooseClient([], appUrl)).toBeNull()
  })
})
