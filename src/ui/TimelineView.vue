<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { CachedMessage } from '../db/group-db'
import { openGroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'
import type { StorageProvider } from '../storage/provider'
import { syncGroup } from '../sync/sync'

const props = defineProps<{ session: Session; storage: StorageProvider }>()
const emit = defineEmits<{ open: [messageId: string] }>()

const messages = ref<CachedMessage[]>([])
const lastReadAt = ref<string | null>(null)
const syncError = ref('')
const syncing = ref(false)

const db = openGroupDatabase(props.session.groupId)

/** 未読は端末ローカル計算のみ。既読情報はどこへも送らない(要件書 §4.10)。 */
function isUnread(message: CachedMessage): boolean {
  return lastReadAt.value === null || message.at > lastReadAt.value
}

const unreadCount = computed(() => messages.value.filter(isUnread).length)

async function reload(): Promise<void> {
  try {
    // 2つを直列に await すると、呼び出し側が1ティックしか待たないときに
    // 2つ目が反映されない。まとめて解決させる。
    const [cached, state] = await Promise.all([
      db.messages.toArray(),
      db.syncState.get('lastReadAt'),
    ])
    messages.value = cached.sort((a, b) => (a.at < b.at ? 1 : -1))
    lastReadAt.value = state?.value ?? null
  } catch {
    // 端末の登録解除(設計書 §5.4)などで DB が閉じられた場合は、
    // 表示を最後の状態のまま保つ。読み取り失敗で画面を壊さない。
  }
}

async function sync(): Promise<void> {
  syncError.value = ''
  syncing.value = true
  try {
    await syncGroup({
      storage: props.storage,
      groupId: props.session.groupId,
      keys: props.session.groupKeys,
      db,
    })
  } catch {
    syncError.value = '同期できませんでした。オフラインの可能性があります。'
  } finally {
    syncing.value = false
    await reload()
  }
}

onMounted(reload)
</script>

<template>
  <section>
    <header>
      <h1>{{ session.groupName }}</h1>
      <p>{{ session.displayName }}</p>
      <p>未読 <span data-test="unread-count">{{ unreadCount }}</span></p>
      <button data-test="sync" :disabled="syncing" @click="sync">いま同期する</button>
    </header>

    <p v-if="syncError" data-test="sync-error">{{ syncError }}</p>

    <p v-if="messages.length === 0" data-test="empty">まだお知らせはありません。</p>

    <ul v-else>
      <li
        v-for="message in messages"
        :key="message.id"
        data-test="message"
        :data-unread="String(isUnread(message))"
        @click="emit('open', message.id)"
      >
        <time>{{ message.at }}</time>
        <p>{{ message.body }}</p>
        <span v-if="message.attachments.length > 0" data-test="has-attachment">添付あり</span>
      </li>
    </ul>
  </section>
</template>
