import { describe, it, expect } from 'vitest'
import { formatWhen } from '../../src/ui/format'

const now = new Date('2026-08-07T12:00:00')

describe('formatWhen', () => {
  it('shows the day and the time for something from this year', () => {
    expect(formatWhen('2026-08-07T09:12:00', now)).toBe('8/7 09:12')
  })

  it('adds the year once it is no longer this year', () => {
    expect(formatWhen('2025-12-31T09:12:00', now)).toBe('2025/12/31')
  })

  it('leaves text it cannot read alone rather than printing Invalid Date', () => {
    expect(formatWhen('not a date', now)).toBe('not a date')
  })
})
