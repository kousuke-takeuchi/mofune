<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Role } from '../crypto/roster'
import type { Session } from '../group/session'
import type { StorageProvider } from '../storage/provider'
import PushToggle from './PushToggle.vue'

const props = defineProps<{
  session: Session
  email: string
  lastSyncedAt: string | null
  /** 通知の窓口を確かめるために読む。渡さない画面では通知の欄を出さない。 */
  storage?: StorageProvider
}>()
const emit = defineEmits<{ signOut: []; forgetDevice: []; registerEmail: [] }>()

const ROLE_LABELS: Record<Role, string> = {
  admin: '管理者',
  staff: '担当者',
  member: '参加者',
}

const confirming = ref(false)

const roleLabel = computed(() => ROLE_LABELS[props.session.role])

const syncedLabel = computed(() => {
  if (!props.lastSyncedAt) return 'まだ同期していません'
  const at = new Date(props.lastSyncedAt)
  return `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(
    at.getMinutes(),
  ).padStart(2, '0')} に同期`
})
</script>

<template>
  <section>
    <header>
      <div class="avatar" aria-hidden="true">{{ session.displayName.slice(0, 1) }}</div>
      <div class="titles">
        <h1>{{ session.displayName }}</h1>
        <p>{{ email }} · {{ session.groupName }}</p>
      </div>
      <p class="badge">{{ roleLabel }}</p>
    </header>

    <h2>通知</h2>
    <p class="hint">
      連絡先は担当者と管理者だけが見られます。ほかの参加者には表示されません。
    </p>
    <button type="button" data-test="register-email" @click="emit('registerEmail')">
      メールアドレスを登録し直す
    </button>
    <PushToggle v-if="storage" :session="session" :storage="storage" />

    <h2>データ</h2>
    <p data-test="last-synced">{{ syncedLabel }}</p>

    <h2>アカウント</h2>
    <button type="button" data-test="sign-out" @click="emit('signOut')">ログアウト</button>

    <button type="button" class="danger" data-test="forget" @click="confirming = true">
      この端末の登録を解除
    </button>

    <template v-if="confirming">
      <p class="hint">
        解除すると、次に入るときは紙の接続コードを打ち直すことになります。端末の中の
        控えも消えます。
      </p>
      <div class="row">
        <button type="button" class="danger" data-test="forget-confirm" @click="emit('forgetDevice')">
          解除する
        </button>
        <button type="button" class="quiet" data-test="forget-cancel" @click="confirming = false">
          やめる
        </button>
      </div>
    </template>
  </section>
</template>
