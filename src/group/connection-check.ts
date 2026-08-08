import type { Bytes } from '../crypto/bytes'
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
 * ブラウザは CORS で弾かれた事実を JS に教えず、TypeError('Failed to fetch') だけ返す。
 * 素の文言を出しても何を直せばよいか分からないので、疑うべき設定を添える。
 */
function describeRequestFailure(cause: unknown, method: string): string {
  const message = describeCause(cause)
  if (cause instanceof TypeError) {
    return `${message} (サーバーまで届いていません。CORS の AllowedMethods に ${method} が入っているか、AllowedOrigins がこのサイトを許しているか確認してください)`
  }
  return message
}

/**
 * 失敗の理由を返す。読めたなら undefined。
 *
 * 確かめるのは「資格情報を持たない人が本当に読めるか」なので、参加者が使う
 * のと同じ経路 (公開URLへの素の GET、WebDAV の公開共有、関数経由) で読む。
 */
async function checkPublicRead(
  reader: StorageProvider,
  probe: string,
  payload: Bytes,
): Promise<string | undefined> {
  let read: Bytes
  try {
    read = await reader.get(probe)
  } catch (cause) {
    // CORS で弾かれた場合もここに来る。ブラウザは理由を教えてくれない。
    return `公開の経路から読めません (CORS 設定か URL の誤り): ${describeCause(cause)}`
  }
  if (fromUtf8(read) !== fromUtf8(payload)) {
    return '公開の経路が別の内容を返しました。URL がこの置き場を指しているか確認してください'
  }
  return undefined
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
  /**
   * 参加者が資格情報なしで読むときの経路。S3 なら公開URLへの素の GET で、
   * API エンドポイントとは別物。取り違えると参加者は 401 で何も読めない。
   */
  publicReader?: StorageProvider
}): Promise<CheckResult> {
  const steps: CheckStep[] = []
  const probe = `${options.groupId}/.connection-check-${toHex(randomBytes(8))}`
  const payload = utf8(`mofune connection check ${new Date().toISOString()}`)

  try {
    await options.storage.put(probe, payload)
    steps.push({ name: 'write', ok: true, detail: '書き込みに成功しました' })
  } catch (cause) {
    steps.push({ name: 'write', ok: false, detail: `書き込めません: ${describeRequestFailure(cause, 'PUT')}` })
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
    steps.push({ name: 'read', ok: false, detail: `読み戻せません: ${describeRequestFailure(cause, 'GET')}` })
    return { ok: false, steps }
  }

  if (options.publicReader) {
    const failure = await checkPublicRead(options.publicReader, probe, payload)
    if (failure) {
      steps.push({ name: 'public', ok: false, detail: failure })
      // 確認用のオブジェクトは残さない。失敗しても後片付けは試みる。
      await options.storage.delete(probe).catch(() => undefined)
      return { ok: false, steps }
    }
    steps.push({ name: 'public', ok: true, detail: '資格情報なしで読めました' })
  }

  try {
    await options.storage.delete(probe)
    steps.push({ name: 'delete', ok: true, detail: '後片付けに成功しました' })
  } catch (cause) {
    steps.push({ name: 'delete', ok: false, detail: `消せません: ${describeRequestFailure(cause, 'DELETE')}` })
    return { ok: false, steps }
  }

  return { ok: true, steps }
}
