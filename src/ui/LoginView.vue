<script setup lang="ts">
import { ref } from 'vue'
import { ConnectionCodeError, decodeConnectionCode } from '../group/connection-code'
import type { Session } from '../group/session'
import { login } from '../group/session'
import { HttpStorageProvider } from '../storage/http'
import { rememberGroup } from '../db/groups'

const props = withDefaults(defineProps<{ initialCode?: string }>(), { initialCode: '' })
const emit = defineEmits<{ login: [session: Session, root: string, adminPublicKey: string] }>()

// QR から来た人は接続コードが入った状態で始まる
const code = ref(props.initialCode)
const email = ref('')
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
      email: email.value,
      password: password.value,
      storage: new HttpStorageProvider(connection.root),
    })
    await rememberGroup({
      code: connection,
      groupName: session.groupName,
      email: email.value,
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
    <div class="brand">
      <svg viewBox="0 0 200 190" aria-hidden="true">
        <ellipse cx="100" cy="152" rx="60" ry="10" fill="#3B322A" opacity=".07" />
        <circle cx="58" cy="82" r="26" fill="#FFFFFF" />
        <circle cx="142" cy="82" r="26" fill="#FFFFFF" />
        <circle cx="78" cy="52" r="26" fill="#FFFFFF" />
        <circle cx="124" cy="50" r="24" fill="#FFFFFF" />
        <ellipse cx="100" cy="92" rx="54" ry="48" fill="#FFFFFF" />
        <ellipse cx="100" cy="139" rx="46" ry="16" fill="#E8A03C" />
        <rect x="54" y="112" width="92" height="26" rx="13" fill="#E8A03C" />
        <path d="M74 88 q8 -9 16 0" stroke="#3B322A" stroke-width="4" fill="none" stroke-linecap="round" />
        <path d="M110 88 q8 -9 16 0" stroke="#3B322A" stroke-width="4" fill="none" stroke-linecap="round" />
        <ellipse cx="64" cy="103" rx="9" ry="6" fill="#F2A28C" opacity=".75" />
        <ellipse cx="136" cy="103" rx="9" ry="6" fill="#F2A28C" opacity=".75" />
        <path d="M92 100 q8 8 16 0" stroke="#3B322A" stroke-width="3.4" fill="none" stroke-linecap="round" />
      </svg>
      <h1>Mofune にログイン</h1>
      <p class="hint">配られた紙の情報でログインします</p>
    </div>

    <label>
      接続コード
      <textarea v-model="code" data-test="code" rows="3" autocomplete="off" />
    </label>

    <label>
      メールアドレス
      <input v-model="email" data-test="email" type="email" autocomplete="username email" />
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

    <button type="submit" class="primary" :disabled="busy">
      {{ busy ? '確認しています…' : 'ログイン' }}
    </button>

    <p class="hint center">パスワードを忘れた場合は管理者へ</p>
  </form>
</template>
