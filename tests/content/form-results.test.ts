import { describe, it, expect } from 'vitest'
import { formResponsesToCsv, pendingResponders } from '../../src/content/form-results'
import type { RosterContents } from '../../src/crypto/roster'
import type { StoredFormResponse } from '../../src/db/group-db'

const roster: RosterContents = {
  groupId: 'midori',
  generation: 1,
  subgroups: [{ id: 'sg_a', name: 'Aチーム', parent: null }],
  members: [
    {
      userId: 'u_tanaka',
      displayName: '田中 みか',
      role: 'staff',
      scopes: ['all', 'staff', 'sg_a'],
      ecdhPublic: 'x',
      ecdsaPublic: 'x',
    },
    {
      userId: 'u_sato',
      displayName: '佐藤 さくら',
      role: 'member',
      scopes: ['all', 'sg_a'],
      ecdhPublic: 'x',
      ecdsaPublic: 'x',
    },
    {
      userId: 'u_mori',
      displayName: '森 ゆい',
      role: 'member',
      scopes: ['all', 'sg_a'],
      ecdhPublic: 'x',
      ecdsaPublic: 'x',
    },
    {
      userId: 'u_other',
      displayName: '別の 人',
      role: 'member',
      scopes: ['all', 'sg_b'],
      ecdhPublic: 'x',
      ecdsaPublic: 'x',
    },
  ],
}

function response(userId: string, displayName: string): StoredFormResponse {
  return {
    id: `fm_1:${userId}`,
    formId: 'fm_1',
    messageId: 'm_1',
    userId,
    displayName,
    choice: '参加します',
    note: '',
    at: '2026-08-08T09:00:00.000Z',
  }
}

describe('pendingResponders', () => {
  it('is the people the post went to, minus the ones who answered', () => {
    const pending = pendingResponders({
      roster,
      scopes: ['sg_a'],
      responses: [response('u_sato', '佐藤 さくら')],
      excludeUserId: 'u_tanaka',
    })
    expect(pending.map((person) => person.userId)).toEqual(['u_mori'])
  })

  it('leaves out people the post never went to', () => {
    const pending = pendingResponders({ roster, scopes: ['sg_a'], responses: [] })
    expect(pending.map((person) => person.userId)).not.toContain('u_other')
  })

  it('counts the author out, because they asked the question', () => {
    const pending = pendingResponders({
      roster,
      scopes: ['sg_a'],
      responses: [],
      excludeUserId: 'u_tanaka',
    })
    expect(pending.map((person) => person.userId)).toEqual(['u_sato', 'u_mori'])
  })

  it('is empty once everyone has answered', () => {
    const pending = pendingResponders({
      roster,
      scopes: ['sg_a'],
      responses: [response('u_sato', '佐藤 さくら'), response('u_mori', '森 ゆい')],
      excludeUserId: 'u_tanaka',
    })
    expect(pending).toEqual([])
  })
})

describe('formResponsesToCsv', () => {
  it('has a header and one row per answer', () => {
    const csv = formResponsesToCsv({
      question: '来ますか',
      responses: [response('u_sato', '佐藤 さくら')],
    })
    const lines = csv.trim().split('\r\n')
    expect(lines[0]).toBe('名前,回答,ひとこと,受け取った日時')
    expect(lines[1]).toContain('佐藤 さくら')
    expect(lines[1]).toContain('参加します')
  })

  it('quotes a value that contains a comma or a quote, so the columns do not shift', () => {
    const csv = formResponsesToCsv({
      question: 'q',
      responses: [
        {
          ...response('u_sato', '佐藤, さくら'),
          note: '「行きます」と伝えました "たぶん"',
        },
      ],
    })
    expect(csv).toContain('"佐藤, さくら"')
    expect(csv).toContain('""たぶん""')
  })

  it('does not let a value start a spreadsheet formula', () => {
    const csv = formResponsesToCsv({
      question: 'q',
      responses: [{ ...response('u_sato', '=SUM(A1:A9)'), note: '' }],
    })
    // 表計算ソフトが式として実行しないよう頭を落とす
    expect(csv).not.toContain('\r\n=SUM')
    expect(csv).toContain("'=SUM(A1:A9)")
  })
})
