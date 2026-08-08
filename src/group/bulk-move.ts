import { fromBase64 } from '../crypto/bytes'
import { verifyRoster } from '../crypto/roster'
import type { StorageProvider } from '../storage/provider'
import type { ConnectionCode } from './connection-code'
import { loadRosterFile } from './roster-update'
import { assertAdmin } from './roster-writer'
import type { Session } from './session'
import type { StorageSettings } from './storage-credentials'
import { setMemberScopes } from './subgroups'

export class BulkMoveError extends Error {}

/**
 * ある組にいる人を全員まとめて別の組へ移す。年度の切り替えで使う。
 *
 * 1人ずつ `setMemberScopes` を呼ぶ。名簿の再署名が人数ぶん走るので速くはないが、
 * 途中で失敗しても、そこまでの移動は名簿に残って整合している。まとめて書くと、
 * 失敗したときに誰がどこにいるのか分からない名簿ができる。
 */
export async function moveEveryone(options: {
  storage: StorageProvider
  session: Session
  code: ConnectionCode
  settings: StorageSettings
  from: string
  to: string
}): Promise<{ moved: string[] }> {
  assertAdmin(options.session, BulkMoveError)

  if (options.from === options.to) {
    throw new BulkMoveError('移動元と移動先が同じです')
  }

  const contents = await verifyRoster(
    await loadRosterFile({ storage: options.storage, groupId: options.code.groupId }),
    fromBase64(options.code.adminPublicKey),
  )
  const ids = new Set(contents.subgroups.map((group) => group.id))
  if (!ids.has(options.from)) {
    throw new BulkMoveError('移動元のサブグループが見つかりません')
  }
  if (!ids.has(options.to)) {
    throw new BulkMoveError('移動先のサブグループが見つかりません')
  }

  const targets = contents.members.filter((member) => member.scopes.includes(options.from))
  const moved: string[] = []

  // 名簿は1人動かすたびに世代が上がる。毎回いまの名簿から所属を読み直す。
  let session = options.session
  for (const target of targets) {
    const current = await verifyRoster(
      await loadRosterFile({ storage: options.storage, groupId: options.code.groupId }),
      fromBase64(options.code.adminPublicKey),
    )
    const member = current.members.find((candidate) => candidate.userId === target.userId)
    if (!member) continue

    // all と staff は resolveScopes が付け直すので、末端のサブグループだけ渡す
    const leaf = member.scopes.filter((scope) => ids.has(scope) && scope !== options.from)
    await setMemberScopes({
      storage: options.storage,
      session,
      code: options.code,
      settings: options.settings,
      userId: target.userId,
      scopes: [...new Set([...leaf, options.to])],
    })
    moved.push(target.userId)
    session = { ...session, roster: current }
  }

  return { moved }
}
