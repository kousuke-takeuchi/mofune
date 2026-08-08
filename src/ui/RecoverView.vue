<script setup lang="ts">
import { computed, ref } from 'vue'
import AppBar from './AppBar.vue'
import { ConnectionCodeError, decodeConnectionCode } from '../group/connection-code'
import { RecoveryError, restoreFromRecoveryKit } from '../group/recovery'
import type { StorageSettings } from '../group/storage-credentials'
import type { KdfParams } from '../crypto/kdf'
import type { StorageProvider } from '../storage/provider'
import { HttpStorageProvider } from '../storage/http'

const props = defineProps<{
  /** テストから差し替える。既定は公開読み取りと資格情報由来の S3。 */
  kdf?: KdfParams
  createStorage?: (root: string) => StorageProvider
  createWriter?: (settings: StorageSettings) => StorageProvider
}>()
const emit = defineEmits<{ back: []; restored: [connectionCode: string, email: string] }>()

const code = ref('')
const paper = ref('')
const email = ref('')
const password = ref('')
const revealed = ref(false)
const busy = ref(false)
const error = ref('')
const done = ref<{ groupName: string; email: string } | null>(null)

const ready = computed(
  () =>
    code.value.trim() !== '' &&
    paper.value.trim() !== '' &&
    email.value.trim() !== '' &&
    password.value !== '',
)

async function restore(): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    const connection = decodeConnectionCode(code.value)
    const storage = props.createStorage
      ? props.createStorage(connection.root)
      : new HttpStorageProvider(connection.root)

    const result = await restoreFromRecoveryKit({
      storage,
      code: connection,
      text: paper.value,
      email: email.value,
      password: password.value,
      ...(props.kdf ? { kdf: props.kdf } : {}),
      ...(props.createWriter ? { createWriter: props.createWriter } : {}),
    })
    done.value = { groupName: result.groupName, email: result.email }
    paper.value = ''
    password.value = ''
    emit('restored', code.value, result.email)
  } catch (caught) {
    error.value =
      caught instanceof ConnectionCodeError
        ? '接続コードを読み取れませんでした。配布された用紙のコードを確認してください'
        : caught instanceof RecoveryError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : String(caught)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section>
    <AppBar title="復元コードから入り直す">
      <template #left>
        <button type="button" class="quiet" data-test="back" @click="emit('back')">戻る</button>
      </template>
    </AppBar>

    <p v-if="done" data-test="done">
      {{ done.groupName }} に入り直せるようになりました。
      {{ done.email }} と新しいパスワードでログインしてください。
    </p>

    <template v-else>
      <p>
        グループを開設したときに印刷した「復元コード」があれば、パスワードを忘れても
        管理者として入り直せます。
      </p>
      <p class="hint">
        この紙は鍵そのものです。作業が済んだら元の保管場所へ戻してください。
      </p>

      <label>
        接続コード
        <textarea v-model="code" data-test="code" rows="3" autocomplete="off" />
      </label>

      <label>
        復元コード (紙に印刷されたもの)
        <textarea v-model="paper" data-test="paper" rows="4" autocomplete="off" />
      </label>

      <label>
        これから使うメールアドレス
        <input v-model="email" data-test="email" type="email" autocomplete="username email" />
      </label>

      <label>
        <span class="label-row">
          新しいパスワード
          <button type="button" class="quiet" data-test="reveal" @click="revealed = !revealed">
            {{ revealed ? '隠す' : '表示' }}
          </button>
        </span>
        <input
          v-model="password"
          data-test="password"
          :type="revealed ? 'text' : 'password'"
          autocomplete="new-password"
        />
      </label>

      <p v-if="error" data-test="error" role="alert">{{ error }}</p>

      <div class="sticky-actions">
        <button
          type="button"
          class="primary"
          data-test="restore"
          :disabled="busy || !ready"
          @click="restore"
        >
          {{ busy ? '作り直しています…' : '復元する' }}
        </button>
      </div>
    </template>
  </section>
</template>
