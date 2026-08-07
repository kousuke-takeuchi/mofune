import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  registryDb,
  rememberGroup,
  listGroups,
  getGroup,
  forgetGroup,
} from '../../src/db/groups'
import type { ConnectionCode } from '../../src/group/connection-code'

const midori: ConnectionCode = {
  v: 1,
  groupId: 'midori',
  provider: 's3',
  root: 'https://example.invalid/midori',
  pepper: 'cGVwcGVy',
  adminPublicKey: 'BAAA',
}

const aozora: ConnectionCode = { ...midori, groupId: 'aozora', root: 'https://example.invalid/aozora' }

beforeEach(async () => {
  await registryDb.groups.clear()
})

describe('group registry', () => {
  it('remembers a group and reads it back as a decoded connection code', async () => {
    await rememberGroup({ code: midori, groupName: 'みどり台グループ', loginId: 'sato', at: 1000 })
    const stored = await getGroup('midori')
    expect(stored?.code).toEqual(midori)
    expect(stored?.groupName).toBe('みどり台グループ')
    expect(stored?.loginId).toBe('sato')
  })

  it('returns undefined for an unknown group', async () => {
    expect(await getGroup('nope')).toBeUndefined()
  })

  it('lists groups with the most recently used first', async () => {
    await rememberGroup({ code: midori, groupName: 'みどり台', loginId: 'sato', at: 1000 })
    await rememberGroup({ code: aozora, groupName: 'うめ', loginId: 'sato', at: 2000 })
    expect((await listGroups()).map((group) => group.groupId)).toEqual(['aozora', 'midori'])
  })

  it('updates an existing group instead of duplicating it', async () => {
    await rememberGroup({ code: midori, groupName: 'みどり台', loginId: 'sato', at: 1000 })
    await rememberGroup({ code: midori, groupName: 'みどり台グループ', loginId: 'tanaka', at: 3000 })
    const groups = await listGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0]?.groupName).toBe('みどり台グループ')
    expect(groups[0]?.loginId).toBe('tanaka')
  })

  it('forgets a group', async () => {
    await rememberGroup({ code: midori, groupName: 'みどり台', loginId: 'sato', at: 1000 })
    await forgetGroup('midori')
    expect(await listGroups()).toHaveLength(0)
  })

  it('never persists a password field', async () => {
    await rememberGroup({ code: midori, groupName: 'みどり台', loginId: 'sato', at: 1000 })
    const raw = await registryDb.groups.get('midori')
    expect(JSON.stringify(raw)).not.toContain('password')
    expect(Object.keys(raw ?? {}).sort()).toEqual([
      'code',
      'groupId',
      'groupName',
      'lastLoginAt',
      'loginId',
    ])
  })
})
