import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ATTENDANCE_CHOICES,
  FormError,
  buildForm,
  buildResponse,
  isClosed,
  parseFormResponse,
  isFormResponse,
  tally,
} from '../../src/content/forms'
import { utf8 } from '../../src/crypto/bytes'
import type { Bytes } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'

function session(): Session {
  return {
    groupId: 'midori',
    groupName: 'みどり台',
    userId: 'u_tanaka',
    displayName: '田中 みか',
    role: 'staff',
    scopes: [],
    groupKeys: new Map(),
    generation: 1,
    roster: {
      groupId: 'midori',
      generation: 1,
      subgroups: [],
      members: [
        {
          userId: 'u_tanaka',
          displayName: '田中 みか',
          role: 'staff',
          scopes: [],
          ecdhPublic: 'PUB',
          ecdsaPublic: '',
        },
      ],
    },
    ecdhPrivate: new Uint8Array(0) as Bytes,
    ecdsaPrivate: new Uint8Array(0) as Bytes,
  } as unknown as Session
}

describe('buildForm', () => {
  it('addresses the answers to the person who asked', () => {
    const form = buildForm({
      session: session(),
      question: '来週の集まり、参加できますか?',
      choices: DEFAULT_ATTENDANCE_CHOICES,
      allowNote: true,
      dueAt: null,
    })
    expect(form.recipient).toEqual({ userId: 'u_tanaka', ecdhPublic: 'PUB' })
  })

  it('gives every form its own id', () => {
    const two = ['はい', 'いいえ']
    const a = buildForm({ session: session(), question: 'q', choices: two, allowNote: false, dueAt: null })
    const b = buildForm({ session: session(), question: 'q', choices: two, allowNote: false, dueAt: null })
    expect(a.id).not.toBe(b.id)
  })

  it('refuses a form with no question', () => {
    expect(() =>
      buildForm({ session: session(), question: '  ', choices: ['はい', 'いいえ'], allowNote: false, dueAt: null }),
    ).toThrow(FormError)
  })

  it('refuses a form with fewer than two choices', () => {
    // 選べないものは問いではない
    expect(() =>
      buildForm({ session: session(), question: 'q', choices: ['はい'], allowNote: false, dueAt: null }),
    ).toThrow(FormError)
  })

  it('offers 参加します / 欠席します as the attendance default', () => {
    expect(DEFAULT_ATTENDANCE_CHOICES).toEqual(['参加します', '欠席します'])
  })
})

describe('isClosed', () => {
  const form = {
    id: 'f_1',
    question: 'q',
    choices: ['a', 'b'],
    allowNote: false,
    dueAt: '2026-08-09T09:00:00.000Z',
    recipient: { userId: 'u_tanaka', ecdhPublic: 'PUB' },
  }

  it('is open before the deadline', () => {
    expect(isClosed(form, new Date('2026-08-08T00:00:00Z'))).toBe(false)
  })

  it('is closed once the deadline has passed', () => {
    expect(isClosed(form, new Date('2026-08-10T00:00:00Z'))).toBe(true)
  })

  it('never closes when there is no deadline', () => {
    expect(isClosed({ ...form, dueAt: null }, new Date('2099-01-01T00:00:00Z'))).toBe(false)
  })
})

describe('buildResponse', () => {
  it('carries who answered and what they picked', () => {
    const response = buildResponse({
      session: session(),
      formId: 'f_1',
      messageId: 'm_1',
      choice: '参加します',
      note: '送迎の相談をしたいです',
    })
    expect(response).toMatchObject({
      kind: 'form-response',
      formId: 'f_1',
      messageId: 'm_1',
      userId: 'u_tanaka',
      displayName: '田中 みか',
      choice: '参加します',
      note: '送迎の相談をしたいです',
    })
  })

  it('refuses an answer that is not one of the choices at the call site', () => {
    expect(() =>
      buildResponse({
        session: session(),
        formId: 'f_1',
        messageId: 'm_1',
        choice: '   ',
        note: '',
      }),
    ).toThrow(FormError)
  })
})

describe('isFormResponse / parseFormResponse', () => {
  it('recognises a response', () => {
    const bytes = utf8(
      JSON.stringify(buildResponse({
        session: session(),
        formId: 'f_1',
        messageId: 'm_1',
        choice: 'はい',
        note: '',
      })),
    )
    expect(isFormResponse(bytes)).toBe(true)
    expect(parseFormResponse(bytes).formId).toBe('f_1')
  })

  it('does not mistake something else for a response', () => {
    expect(isFormResponse(utf8(JSON.stringify({ kind: 'absence' })))).toBe(false)
    expect(isFormResponse(utf8('not json'))).toBe(false)
  })
})

describe('tally', () => {
  const answers = [
    { choice: '参加します', userId: 'u_1' },
    { choice: '参加します', userId: 'u_2' },
    { choice: '欠席します', userId: 'u_3' },
  ]

  it('counts each choice, including the ones nobody picked', () => {
    const result = tally(['参加します', '欠席します', '検討中'], answers)
    expect(result.counts).toEqual([
      { choice: '参加します', count: 2 },
      { choice: '欠席します', count: 1 },
      { choice: '検討中', count: 0 },
    ])
  })

  it('counts how many people answered', () => {
    expect(tally(['参加します', '欠席します'], answers).answered).toBe(3)
  })

  it('keeps only the latest answer from the same person', () => {
    const twice = [
      { choice: '参加します', userId: 'u_1' },
      { choice: '欠席します', userId: 'u_1' },
    ]
    const result = tally(['参加します', '欠席します'], twice)
    expect(result.answered).toBe(1)
    expect(result.counts).toEqual([
      { choice: '参加します', count: 0 },
      { choice: '欠席します', count: 1 },
    ])
  })
})
