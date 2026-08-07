import { fromUtf8, toHex, utf8 } from '../crypto/bytes'
import { randomBytes } from '../crypto/symmetric'
import type { StorageProvider } from '../storage/provider'

export interface CheckStep {
  name: string
  ok: boolean
  detail: string
}

export interface CheckResult {
  ok: boolean
  steps: CheckStep[]
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * 書き込む前にストレージを確かめる。
 *
 * 資格情報や CORS が誤ったまま開設すると、参加者が読めないグループができ、
 * 紙を配り直すまで復旧できない。例外を投げず、どの段階で失敗したかを返す。
 */
export async function checkConnection(options: {
  storage: StorageProvider
  groupId: string
}): Promise<CheckResult> {
  const steps: CheckStep[] = []
  const probe = `${options.groupId}/.connection-check-${toHex(randomBytes(8))}`
  const payload = utf8(`mofune connection check ${new Date().toISOString()}`)

  try {
    await options.storage.put(probe, payload)
    steps.push({ name: 'write', ok: true, detail: '書き込みに成功しました' })
  } catch (cause) {
    steps.push({ name: 'write', ok: false, detail: `書き込めません: ${describeCause(cause)}` })
    return { ok: false, steps }
  }

  try {
    const read = await options.storage.get(probe)
    if (fromUtf8(read) !== fromUtf8(payload)) {
      steps.push({
        name: 'read',
        ok: false,
        detail: '書いた内容と読み戻した内容が一致しません',
      })
      return { ok: false, steps }
    }
    steps.push({ name: 'read', ok: true, detail: '読み戻しに成功しました' })
  } catch (cause) {
    steps.push({ name: 'read', ok: false, detail: `読み戻せません: ${describeCause(cause)}` })
    return { ok: false, steps }
  }

  try {
    await options.storage.delete(probe)
    steps.push({ name: 'delete', ok: true, detail: '後片付けに成功しました' })
  } catch (cause) {
    steps.push({ name: 'delete', ok: false, detail: `消せません: ${describeCause(cause)}` })
    return { ok: false, steps }
  }

  return { ok: true, steps }
}
