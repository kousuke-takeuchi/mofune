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

/** 失敗の理由を返す。読めたなら undefined。 */
async function checkPublicRead(
  baseUrl: string,
  probe: string,
  payload: Bytes,
): Promise<string | undefined> {
  const url = `${baseUrl.replace(/\/+$/, '')}/${probe}`
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store' })
  } catch (cause) {
    // CORS で弾かれた場合もここに来る。ブラウザは理由を教えてくれない。
    return `公開URLへ届きません (CORS 設定か URL の誤り): ${describeCause(cause)}`
  }
  if (!response.ok) {
    return `公開URLから読めません (HTTP ${response.status})。公開読み取りの設定を確認してください`
  }
  const read = new Uint8Array(await response.arrayBuffer()) as Bytes
  if (fromUtf8(read) !== fromUtf8(payload)) {
    return '公開URLが別の内容を返しました。URL がこのバケットを指しているか確認してください'
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
   * 参加者が資格情報なしで読む URL の起点。S3 の API エンドポイントとは別物で、
   * R2 なら r2.dev の公開URLか独自ドメイン。取り違えると参加者は 401 で何も読めない。
   */
  publicBaseUrl?: string
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

  if (options.publicBaseUrl) {
    const failure = await checkPublicRead(options.publicBaseUrl, probe, payload)
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
    steps.push({ name: 'delete', ok: false, detail: `消せません: ${describeCause(cause)}` })
    return { ok: false, steps }
  }

  return { ok: true, steps }
}
