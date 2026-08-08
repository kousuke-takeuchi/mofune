// @ts-expect-error GAS へそのまま貼る素の JS。型宣言は持たせない
import { handleRequest } from '../../functions/gas/logic.js'
import { describe, it, expect, beforeEach } from 'vitest'

/**
 * Apps Script は所有者の権限で動くので、Drive をそのままグループの置き場に
 * できる。参加者に OAuth も資格情報も持たせずに済む (設計書 §10.2)。
 *
 * 読みは誰でもできる (中身は封緘済み)。書きは合言葉、上りは引換券。
 */

interface Stored {
  data: Map<string, string>
}

let files: Stored
let deps: Record<string, unknown>

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

beforeEach(() => {
  files = { data: new Map() }
  deps = {
    store: { get: () => null, put: () => undefined },
    tokens: { g_midori: 'shared-secret' },
    vapidPublicKey: 'BPUB',
    sendPush: () => 201,
    objects: {
      get: (key: string) => files.data.get(key) ?? null,
      put: (key: string, body: string) => void files.data.set(key, body),
      remove: (key: string) => void files.data.delete(key),
      list: (prefix: string) =>
        [...files.data.entries()]
          .filter(([key]) => key.indexOf(prefix) === 0)
          .map(([key, body]) => ({ key: key, size: body.length })),
    },
    // 引換券は「合言葉と鍵から作った短い符号」。担当者が配り、関数が確かめる
    verifyTicket: (key: string, ticket: string) => ticket === `ticket-for-${key}`,
  }
})

function call(path: string, body: unknown, method = 'POST') {
  return handleRequest({ path, method, body, authorization: '' }, deps)
}

describe('GET /object', () => {
  it('hands out what is stored, because the bytes are sealed anyway', () => {
    files.data.set('g_midori/messages/m_1.enc', base64('sealed'))
    const result = handleRequest(
      {
        path: '/object',
        method: 'GET',
        body: null,
        authorization: '',
        query: { group_id: 'g_midori', key: 'g_midori/messages/m_1.enc' },
      },
      deps,
    )
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ body: base64('sealed') })
  })

  it('says not found rather than pretending it is empty', () => {
    const result = handleRequest(
      {
        path: '/object',
        method: 'GET',
        body: null,
        authorization: '',
        query: { group_id: 'g_midori', key: 'g_midori/messages/missing.enc' },
      },
      deps,
    )
    expect(result.status).toBe(404)
  })

  it('refuses a key that reaches outside its own group', () => {
    files.data.set('g_other/messages/m_1.enc', base64('sealed'))
    const result = handleRequest(
      {
        path: '/object',
        method: 'GET',
        body: null,
        authorization: '',
        query: { group_id: 'g_midori', key: 'g_other/messages/m_1.enc' },
      },
      deps,
    )
    expect(result.status).toBe(400)
  })
})

describe('POST /object', () => {
  it('writes with the group secret', () => {
    const result = call('/object', {
      group_id: 'g_midori',
      key: 'g_midori/messages/m_1.enc',
      body: base64('sealed'),
      token: 'shared-secret',
    })
    expect(result.status).toBe(200)
    expect(files.data.get('g_midori/messages/m_1.enc')).toBe(base64('sealed'))
  })

  it('refuses without the secret', () => {
    const result = call('/object', {
      group_id: 'g_midori',
      key: 'g_midori/messages/m_1.enc',
      body: base64('sealed'),
    })
    expect(result.status).toBe(401)
    expect(files.data.size).toBe(0)
  })
})

describe('POST /list', () => {
  it('lists a prefix, which no public bucket can do', () => {
    files.data.set('g_midori/events/e_1.enc', base64('a'))
    files.data.set('g_midori/events/e_2.enc', base64('bb'))
    files.data.set('g_midori/messages/m_1.enc', base64('c'))

    const result = call('/list', { group_id: 'g_midori', prefix: 'g_midori/events/' })
    expect(result.status).toBe(200)
    expect((result.body.entries as Array<{ key: string }>).map((entry) => entry.key)).toEqual([
      'g_midori/events/e_1.enc',
      'g_midori/events/e_2.enc',
    ])
  })
})

describe('POST /delete', () => {
  it('needs the secret, because deleting is not something a reader may do', () => {
    files.data.set('g_midori/inbox/u_sato/a.enc', base64('x'))
    expect(call('/delete', { group_id: 'g_midori', key: 'g_midori/inbox/u_sato/a.enc' }).status).toBe(401)
    expect(
      call('/delete', {
        group_id: 'g_midori',
        key: 'g_midori/inbox/u_sato/a.enc',
        token: 'shared-secret',
      }).status,
    ).toBe(200)
    expect(files.data.size).toBe(0)
  })
})

describe('POST /inbox', () => {
  it('takes a drop from a participant who has a ticket', () => {
    const key = 'g_midori/inbox/u_sato/a.enc'
    const result = call('/inbox', {
      group_id: 'g_midori',
      key,
      body: base64('sealed-for-staff'),
      ticket: `ticket-for-${key}`,
    })
    expect(result.status).toBe(200)
    expect(files.data.get(key)).toBe(base64('sealed-for-staff'))
  })

  it('turns away a drop with no ticket, so the box cannot be flooded', () => {
    const key = 'g_midori/inbox/u_sato/a.enc'
    const result = call('/inbox', { group_id: 'g_midori', key, body: base64('x') })
    expect(result.status).toBe(401)
    expect(files.data.size).toBe(0)
  })

  it('only lets a ticket be spent on the inbox', () => {
    const key = 'g_midori/messages/m_1.enc'
    const result = call('/inbox', {
      group_id: 'g_midori',
      key,
      body: base64('x'),
      ticket: `ticket-for-${key}`,
    })
    expect(result.status).toBe(400)
    expect(files.data.size).toBe(0)
  })
})
