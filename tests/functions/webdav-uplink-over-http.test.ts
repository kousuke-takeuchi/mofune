import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { createHmac } from 'node:crypto'
// @ts-expect-error GAS へそのまま貼る素の JS。型宣言は持たせない
import { handleRequest } from '../../functions/gas/logic.js'
import { WebdavStorageProvider } from '../../src/storage/webdav'
import { publishGrants, readGrant } from '../../src/inbox/grants'
import { submitToInbox } from '../../src/inbox/submit'
import { flushOutbox } from '../../src/sync/outbox'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { openAsRecipient } from '../../src/inbox/uplink'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { toBase64, utf8, fromUtf8 } from '../../src/crypto/bytes'
import type { RosterContents } from '../../src/crypto/roster'
import type { Session } from '../../src/group/session'
import type { WebdavStorageSettings } from '../../src/group/storage-credentials'

/**
 * WebDAV の置き場で、参加者からの投函が本当に NAS へ着くところまで通す。
 *
 * WebDAV には presigned URL が無いので、参加者は関数へ引換券つきで送り、
 * 関数が NAS へ書く。ここでは NAS も関数も素の HTTP で立てて、本番と同じ
 * プロバイダとキューを通す。
 */

const TOKEN = 'shared-secret'
const USER = 'mofune'
const PASSWORD = 'nas-secret'

let nas: Server
let nasBase: string
let fn: Server
let fnUrl: string
let folders: Set<string>
let files: Map<string, Buffer>

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

function parentOf(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

/** 本物どおりに振る舞う WebDAV。親フォルダが無ければ 409 を返す。 */
function startNas(): Promise<void> {
  nas = createServer((request, response) => {
    void (async () => {
      const path = decodeURIComponent((request.url ?? '/').replace(/^\/dav\/?/, '')).replace(/\/+$/, '')
      const method = request.method ?? 'GET'
      const body = await readBody(request)
      const header = request.headers.authorization ?? ''
      const [user, password] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':')
      const authorized = header.startsWith('Basic ') && user === USER && password === PASSWORD

      if (method === 'GET') {
        const found = files.get(path)
        response.writeHead(found ? 200 : 404).end(found)
        return
      }
      if (!authorized) {
        response.writeHead(401).end()
        return
      }
      if (method === 'MKCOL') {
        if (parentOf(path) !== '' && !folders.has(parentOf(path))) {
          response.writeHead(409).end()
          return
        }
        folders.add(path)
        response.writeHead(201).end()
        return
      }
      if (method === 'PUT') {
        if (parentOf(path) !== '' && !folders.has(parentOf(path))) {
          response.writeHead(409).end()
          return
        }
        files.set(path, body)
        response.writeHead(201).end()
        return
      }
      if (method === 'DELETE') {
        files.delete(path)
        response.writeHead(204).end()
        return
      }
      response.writeHead(405).end()
    })()
  })
  return new Promise((resolve) => {
    nas.listen(0, '127.0.0.1', () => {
      const address = nas.address()
      const port = typeof address === 'object' && address ? address.port : 0
      nasBase = `http://127.0.0.1:${String(port)}/dav`
      resolve()
    })
  })
}

/** Apps Script の代役。置き場として NAS へ書く。 */
function startFunction(): Promise<void> {
  fn = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const raw = (await readBody(request)).toString('utf8')
      let body: unknown = {}
      try {
        body = raw === '' ? {} : JSON.parse(raw)
      } catch {
        body = {}
      }
      const query: Record<string, string> = {}
      url.searchParams.forEach((value, name) => {
        query[name] = value
      })

      // 関数のなかの WebDAV 書き込み。GAS の mofuneWebdav と同じ手順
      const dav = new WebdavStorageProvider({
        baseUrl: nasBase,
        credentials: { username: USER, password: PASSWORD },
      })

      const result = handleRequest(
        { path: query.path ?? '/', method: request.method, body, authorization: '', query },
        {
          store: { get: () => null, put: () => undefined },
          tokens: { g_midori: TOKEN },
          vapidPublicKey: 'BPUB',
          sendPush: () => 201,
          objects: {
            get: () => null,
            put: (key: string, base64Body: string) => {
              // 同期の口しか無いので、書き込みは投げっぱなしにせず待たせる
              pending.push(dav.put(key, new Uint8Array(Buffer.from(base64Body, 'base64')) as never))
            },
            remove: () => undefined,
            list: () => [],
          },
          verifyTicket: (key: string, ticket: string) =>
            createHmac('sha256', TOKEN).update(key).digest('base64url') === ticket,
        },
      )
      await Promise.all(pending)
      pending.length = 0
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result.body))
    })()
  })
  return new Promise((resolve) => {
    fn.listen(0, '127.0.0.1', () => {
      const address = fn.address()
      const port = typeof address === 'object' && address ? address.port : 0
      fnUrl = `http://127.0.0.1:${String(port)}/macros/s/test/exec`
      resolve()
    })
  })
}

const pending: Array<Promise<void>> = []

beforeAll(async () => {
  await startNas()
  await startFunction()
})

afterAll(async () => {
  await new Promise<void>((resolve) => nas.close(() => resolve()))
  await new Promise<void>((resolve) => fn.close(() => resolve()))
})

beforeEach(async () => {
  folders = new Set<string>([''])
  files = new Map<string, Buffer>()
  await deleteGroupDatabase('g_midori')
})

describe('a participant on a WebDAV group', () => {
  it('drops into the NAS inbox through the function', async () => {
    const staff = await generateEcdhKeyPair()
    const member = await generateEcdhKeyPair()
    const roster: RosterContents = {
      groupId: 'g_midori',
      generation: 1,
      subgroups: [],
      members: [
        {
          userId: 'u_tanaka',
          displayName: '田中 みか',
          role: 'staff',
          scopes: ['all', 'staff'],
          ecdhPublic: toBase64(staff.publicKey),
          ecdsaPublic: 'x',
        },
        {
          userId: 'u_sato',
          displayName: '佐藤 さくら',
          role: 'member',
          scopes: ['all'],
          ecdhPublic: toBase64(member.publicKey),
          ecdsaPublic: 'x',
        },
      ],
    }
    const settings: WebdavStorageSettings = {
      provider: 'webdav',
      baseUrl: nasBase,
      publicBaseUrl: nasBase,
      username: USER,
      password: PASSWORD,
      functionUrl: fnUrl,
      token: TOKEN,
    }

    // 担当者が枠 (引換券) を配る。名簿の場所は NAS
    const staffWriter = new WebdavStorageProvider({
      baseUrl: nasBase,
      credentials: { username: USER, password: PASSWORD },
    })
    const issued = await publishGrants({
      storage: staffWriter,
      groupId: 'g_midori',
      roster,
      settings,
    })
    expect(issued).toEqual(['u_sato'])

    // 参加者は資格情報を持たない読み専用の経路しかない
    const readonly = new WebdavStorageProvider({ baseUrl: nasBase })
    const grant = await readGrant({
      storage: readonly,
      groupId: 'g_midori',
      userId: 'u_sato',
      ecdhPrivate: member.privateKey,
    })

    const session = {
      groupId: 'g_midori',
      groupName: 'みどり台',
      userId: 'u_sato',
      displayName: '佐藤 さくら',
      role: 'member',
      scopes: ['all'],
      groupKeys: new Map(),
      generation: 1,
      roster,
      ecdhPrivate: member.privateKey,
      ecdsaPrivate: new Uint8Array(0),
    } as unknown as Session

    const db = openGroupDatabase('g_midori')
    await submitToInbox({ session, db, grant, plaintext: utf8('体調不良で欠席します') })
    const flushed = await flushOutbox({ db, storage: readonly })

    expect(flushed.failed).toBe(0)
    const first = grant.slots[0]
    if (first?.kind !== 'ticket') throw new Error('expected a ticket slot')

    // NAS に本当に届いていて、開けるのは担当者だけ
    const stored = await readonly.get(first.key)
    const opened = await openAsRecipient('u_tanaka', staff.privateKey, stored)
    expect(fromUtf8(opened)).toContain('体調不良で欠席します')
  })
})
