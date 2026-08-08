<script setup lang="ts">
import { computed, ref } from 'vue'
import { toHex } from '../crypto/bytes'
import type { KdfParams } from '../crypto/kdf'
import { randomBytes } from '../crypto/symmetric'
import type { CheckResult } from '../group/connection-check'
import type { SetupResult } from '../group/setup'
import { SetupError, setUpGroup } from '../group/setup'
import type { StorageSettings } from '../group/storage-credentials'
import { toProviderConfig } from '../group/storage-credentials'
import { FunctionStorageProvider } from '../storage/function'
import { WebdavStorageProvider } from '../storage/webdav'
import QrCode from './QrCode.vue'
import { buildJoinUrl, currentAppBaseUrl } from '../group/join-url'
import type { StorageProvider } from '../storage/provider'
import { S3StorageProvider } from '../storage/s3'

const props = defineProps<{
  /** テストから軽い KDF を渡すためだけの口。既定は本番パラメータ。 */
  kdf?: KdfParams
  /** テストから外部通信しないプロバイダを渡すための口。 */
  createStorage?: (settings: StorageSettings) => StorageProvider
}>()
const emit = defineEmits<{ done: [connectionCode: string]; cancel: [] }>()

const step = ref<1 | 2 | 3>(1)
const error = ref('')
const busy = ref(false)

const groupName = ref('')
const adminDisplayName = ref('')
const adminPassword = ref('')
const adminEmail = ref('')

/** 置き場の種類。原稿 10 の表と同じ並び。 */
const KINDS = [
  { value: 's3' as const, label: 'S3互換 (R2 / B2 / MinIO)' },
  { value: 'gdrive' as const, label: 'Google Drive (Apps Script 経由)' },
  { value: 'webdav' as const, label: 'WebDAV / NAS' },
]
const kind = ref<'s3' | 'gdrive' | 'webdav'>('s3')

const functionUrl = ref('')
const functionToken = ref('')
const davUrl = ref('')
const davUsername = ref('')
const davPassword = ref('')

const endpoint = ref('')
const region = ref('auto')
const bucket = ref('')
const publicBaseUrl = ref('')
const accessKeyId = ref('')
const secretAccessKey = ref('')

const check = ref<CheckResult | null>(null)
const result = ref<SetupResult | null>(null)
const kitStored = ref(false)

/** 紙に印刷して配る URL。読み取り側の実装が要らないのが利点。 */
const joinUrl = computed(() =>
  result.value ? buildJoinUrl(result.value.connectionCode, currentAppBaseUrl()) : '',
)

function toStorageStep(): void {
  const missing =
    !groupName.value.trim() ||
    !adminDisplayName.value.trim() ||
    !adminPassword.value ||
    !adminEmail.value.trim()
  if (missing) {
    error.value = 'グループ名と管理者の情報をすべて入力してください'
    return
  }
  error.value = ''
  step.value = 2
}

/** 書き込み経路は置き場ごとに違う。テストからはまとめて差し替えられる。 */
function buildStorage(settings: StorageSettings, groupId: string): StorageProvider {
  if (props.createStorage) return props.createStorage(settings)
  if (settings.provider === 'gdrive') {
    return new FunctionStorageProvider({
      functionUrl: settings.functionUrl,
      groupId,
      token: settings.token,
    })
  }
  if (settings.provider === 'webdav') {
    return new WebdavStorageProvider({
      baseUrl: settings.baseUrl,
      credentials: { username: settings.username, password: settings.password },
    })
  }
  return new S3StorageProvider(toProviderConfig(settings))
}

/**
 * 入力から設定を組む。足りないものがあれば、何が足りないかを返す。
 * 置き場ごとに要るものが違うので、まとめて「全部入れてください」とは言わない。
 */
function collectSettings(): { settings: StorageSettings } | { missing: string } {
  if (kind.value === 'gdrive') {
    if (!functionUrl.value.trim() || !functionToken.value) {
      return { missing: '関数の URL と合言葉を入れてください' }
    }
    const url = functionUrl.value.trim().replace(/\/+$/, '')
    return {
      settings: {
        provider: 'gdrive',
        functionUrl: url,
        // 参加者もこの関数を通して読む
        publicBaseUrl: url,
        token: functionToken.value,
      },
    }
  }

  if (kind.value === 'webdav') {
    if (
      !davUrl.value.trim() ||
      !publicBaseUrl.value.trim() ||
      !davUsername.value.trim() ||
      !davPassword.value
    ) {
      return { missing: 'WebDAV の URL・公開共有の URL・利用者名・パスワードを入れてください' }
    }
    return {
      settings: {
        provider: 'webdav',
        baseUrl: davUrl.value.trim().replace(/\/+$/, ''),
        publicBaseUrl: publicBaseUrl.value.trim().replace(/\/+$/, ''),
        username: davUsername.value.trim(),
        password: davPassword.value,
      },
    }
  }

  if (
    !endpoint.value.trim() ||
    !bucket.value.trim() ||
    !publicBaseUrl.value.trim() ||
    !accessKeyId.value ||
    !secretAccessKey.value
  ) {
    return { missing: 'データの置き場の情報をすべて入力してください' }
  }
  return {
    settings: {
      provider: 's3',
      endpoint: endpoint.value.trim(),
      region: region.value.trim() || 'auto',
      bucket: bucket.value.trim(),
      publicBaseUrl: publicBaseUrl.value.trim().replace(/\/+$/, ''),
      accessKeyId: accessKeyId.value,
      secretAccessKey: secretAccessKey.value,
    },
  }
}

async function provision(): Promise<void> {
  const collected = collectSettings()
  if ('missing' in collected) {
    error.value = collected.missing
    return
  }
  error.value = ''
  busy.value = true
  const settings = collected.settings
  // グループIDは表示名から作らない。パスに使うので、衝突も細工も避けて乱数にする。
  const groupId = `g_${toHex(randomBytes(6))}`
  step.value = 3
  try {
    const setup = await setUpGroup({
      groupId,
      groupName: groupName.value.trim(),
      adminDisplayName: adminDisplayName.value.trim(),
      adminPassword: adminPassword.value,
      adminEmail: adminEmail.value.trim(),
      settings,
      storage: buildStorage(settings, groupId),
      ...(props.kdf ? { kdf: props.kdf } : {}),
    })
    check.value = setup.check
    result.value = setup
  } catch (cause) {
    // 接続確認で止まった場合は何も書かれていない。どこまで通ってどこで落ちたかを
    // そのまま出す。丸めると、直すべき設定が分からなくなる。
    const detail = cause instanceof Error ? cause.message : 'グループを開設できませんでした'
    check.value =
      cause instanceof SetupError && cause.check
        ? cause.check
        : { ok: false, steps: [{ name: 'setup', ok: false, detail }] }
    error.value = detail
  } finally {
    busy.value = false
  }
}

function finish(): void {
  if (!result.value) return
  if (!kitStored.value) {
    error.value = 'リカバリキットを保管したことを確認してください'
    return
  }
  emit('done', result.value.connectionCode)
}

function printPage(): void {
  window.print()
}

function back(): void {
  error.value = ''
  step.value = 1
}
</script>

<template>
  <section>
    <h1>グループを作る</h1>
    <p data-test="step">ステップ {{ step }} / 3</p>
    <p v-if="error" data-test="error">{{ error }}</p>

    <template v-if="step === 1">
      <label>
        グループの名前
        <input data-test="group-name" v-model="groupName" />
      </label>
      <label>
        管理者の表示名
        <input data-test="admin-display-name" v-model="adminDisplayName" />
      </label>
      <label>
        管理者のパスワード
        <input type="password" data-test="admin-password" v-model="adminPassword" />
      </label>
      <label>
        管理者のメールアドレス(ログインに使います)
        <input type="email" data-test="admin-email" v-model="adminEmail" />
      </label>

      <button type="button" class="primary" data-test="next" @click="toStorageStep">次へ</button>
      <button type="button" class="quiet" data-test="cancel" @click="emit('cancel')">やめる</button>
    </template>

    <template v-else-if="step === 2">
      <h2>データの置き場</h2>
      <p>
        置き場によって、参加者からの上り経路(欠席・おやすみなどの連絡やフォーム回答)が
        使えるかどうかが変わります。選ぶ前に確かめてください。
      </p>
      <table>
        <thead>
          <tr><th>置き場</th><th>公開読み</th><th>参加者からの連絡</th></tr>
        </thead>
        <tbody>
          <tr><td>S3互換 (R2 / B2 / MinIO)</td><td>できる</td><td>できる</td></tr>
          <tr><td>Google Drive (Apps Script 経由)</td><td>できる</td><td>できる</td></tr>
          <tr><td>WebDAV / NAS</td><td>できる</td><td>できる</td></tr>
          <tr><td>Dropbox / Box / OneDrive</td><td><strong>使えません</strong></td><td><strong>使えません</strong></td></tr>
        </tbody>
      </table>

      <fieldset class="dark-choice">
        <legend>置き場の種類</legend>
        <button
          v-for="entry in KINDS"
          :key="entry.value"
          type="button"
          data-test="storage-kind"
          :data-kind="entry.value"
          :aria-pressed="kind === entry.value"
          @click="kind = entry.value"
        >
          {{ entry.label }}
        </button>
      </fieldset>

      <template v-if="kind === 'gdrive'">
        <p class="hint">
          Apps Script は所有者の権限で動くので、Drive の読み書きに OAuth は要りません。
          先に <code>functions/gas/</code> の手順でスクリプトを置き、
          <code>DRIVE_FOLDER_ID</code> を入れておいてください。
        </p>
        <label>
          関数の URL
          <input data-test="function-url" v-model="functionUrl" placeholder="https://script.google.com/macros/s/.../exec" />
        </label>
        <label>
          合言葉
          <input data-test="function-token" v-model="functionToken" />
        </label>
      </template>

      <template v-else-if="kind === 'webdav'">
        <p class="hint">
          書き込みは利用者名とパスワードで、参加者は公開共有の URL から読みます。
          公開共有にパスワードを付けると参加者が読めなくなります。
        </p>
        <label>
          WebDAV の URL (書き込み用)
          <input data-test="dav-url" v-model="davUrl" placeholder="https://nas.example/remote.php/dav/files/mofune" />
        </label>
        <label>
          公開共有の URL (参加者が読む)
          <input data-test="public-base-url" v-model="publicBaseUrl" placeholder="https://nas.example/public.php/dav/files/TOKEN" />
        </label>
        <label>
          利用者名
          <input data-test="dav-username" v-model="davUsername" />
        </label>
        <label>
          パスワード
          <input type="password" data-test="dav-password" v-model="davPassword" />
        </label>
      </template>

      <template v-else>

      <label>
        エンドポイント
        <input data-test="endpoint" v-model="endpoint" />
      </label>
      <label>
        リージョン
        <input data-test="region" v-model="region" />
      </label>
      <label>
        バケット
        <input data-test="bucket" v-model="bucket" />
      </label>
      <label>
        公開読み取りURL
        <input data-test="public-base-url" v-model="publicBaseUrl" placeholder="https://pub-xxxx.r2.dev" />
      </label>
      <p>
        参加者はアカウントを持たずに読みます。<strong>上のエンドポイントとは別のURL</strong>で、R2 なら
        r2.dev の公開URLか、割り当てた独自ドメインです。ここを間違えると参加者は何も読めません。
      </p>
      <label>
        アクセスキーID
        <input data-test="access-key-id" v-model="accessKeyId" />
      </label>
      <label>
        シークレットアクセスキー
        <input type="password" data-test="secret-access-key" v-model="secretAccessKey" />
      </label>
      </template>

      <button type="button" class="primary" data-test="next" :disabled="busy" @click="provision">
        接続を確かめて作る
      </button>
      <button type="button" class="quiet" data-test="back" @click="back">戻る</button>
    </template>

    <template v-else>
      <h2>接続の確認</h2>
      <p v-if="busy">確かめています…</p>
      <ul v-if="check" data-test="check-result">
        <li v-for="entry in check.steps" :key="entry.name" data-test="check-step">
          {{ entry.name }}: {{ entry.ok ? 'OK' : 'NG' }} — {{ entry.detail }}
        </li>
      </ul>
      <p v-if="check && !check.ok">
        まだ何も書き込んでいません。設定を直してやり直してください。
      </p>
      <button v-if="check && !check.ok" type="button" data-test="back" @click="step = 2">
        設定に戻る
      </button>

      <template v-if="result">
        <h2>参加者に配る接続コード</h2>
        <p>
          この画面を離れると<strong>二度と表示できません</strong>。
          接続コードはストレージからは復元できません(pepper を含むため)。
        </p>
        <p>
          紙に印刷して配ります。参加者は QR を端末のカメラで読むだけで、コードが入った
          状態のログイン画面が開きます。
        </p>
        <QrCode :text="joinUrl" label="参加用のQRコード" />
        <p class="hint" data-test="join-url">{{ joinUrl }}</p>

        <details>
          <summary>接続コードの文字列</summary>
          <pre data-test="connection-code">{{ result.connectionCode }}</pre>
        </details>

        <h2>リカバリキット</h2>
        <p>
          これは管理者のルート鍵そのものです。<strong>暗号化していません。</strong>
          印刷して、鍵のかかる場所に紙で保管してください。安全性は紙の管理に依存します。
        </p>
        <p>
          失うと名簿を二度と再署名できなくなり、メンバーの追加・削除ができなくなります。
          この画面を離れると二度と表示できません。
        </p>
        <p>グループ: {{ result.recoveryKit.groupName }} ({{ result.recoveryKit.groupId }})</p>
        <p>照合用チェックサム: {{ result.recoveryKit.checksum }}</p>
        <pre data-test="recovery-code">{{ result.recoveryKit.code }}</pre>
        <button type="button" data-test="print" @click="printPage">印刷する</button>

        <label>
          <input type="checkbox" data-test="kit-stored" v-model="kitStored" />
          リカバリキットと接続コードを紙に控えて保管しました
        </label>
        <button type="button" class="primary" data-test="finish" @click="finish">できあがり</button>
      </template>
    </template>
  </section>
</template>
