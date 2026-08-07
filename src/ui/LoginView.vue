<script setup lang="ts">
import { ref } from 'vue'
import { ConnectionCodeError, decodeConnectionCode } from '../group/connection-code'
import type { Session } from '../group/session'
import { login } from '../group/session'
import { HttpStorageProvider } from '../storage/http'
import { rememberGroup } from '../db/groups'

const emit = defineEmits<{ login: [session: Session, root: string, adminPublicKey: string] }>()

const code = ref('')
const loginId = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit(): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    const connection = decodeConnectionCode(code.value)
    // 読み取りは provider に関わらず root への素の GET。s3 も公開URLを root に持つので
    // ここを通す。まだ経路を実装していないものだけ断る。
    if (connection.provider !== 'http' && connection.provider !== 's3') {
      throw new Error(
        `ストレージ "${connection.provider}" はこのバージョンではまだ利用できません`,
      )
    }
    const session = await login({
      code: connection,
      loginId: loginId.value,
      password: password.value,
      storage: new HttpStorageProvider(connection.root),
    })
    await rememberGroup({
      code: connection,
      groupName: session.groupName,
      loginId: loginId.value,
      at: Date.now(),
    })
    password.value = ''
    emit('login', session, connection.root, connection.adminPublicKey)
  } catch (caught) {
    error.value =
      caught instanceof ConnectionCodeError
        ? '接続コードを読み取れませんでした。配布された用紙のコードを確認してください'
        : caught instanceof Error
          ? caught.message
          : String(caught)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form data-test="submit" @submit.prevent="submit">
    <h1>Mofune にログイン</h1>

    <label>
      接続コード
      <textarea v-model="code" data-test="code" rows="3" autocomplete="off" />
    </label>

    <label>
      ログインID
      <input v-model="loginId" data-test="login-id" type="text" autocomplete="username" />
    </label>

    <label>
      パスワード
      <input
        v-model="password"
        data-test="password"
        type="password"
        autocomplete="current-password"
      />
    </label>

    <p v-if="error" data-test="error" role="alert">{{ error }}</p>

    <button type="submit" :disabled="busy">
      {{ busy ? '確認しています…' : 'ログイン' }}
    </button>
  </form>
</template>
