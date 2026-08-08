<script setup lang="ts">
defineOptions({ name: 'TimelineView' })

import { formatWhen } from './format'

import { computed, onMounted, ref } from 'vue'
import type { CachedMessage } from '../db/group-db'
import { openGroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'
import type { StorageProvider } from '../storage/provider'
import { syncGroup } from '../sync/sync'

const props = defineProps<{ session: Session; storage: StorageProvider }>()
const emit = defineEmits<{ open: [messageId: string] }>()

const messages = ref<CachedMessage[]>([])
/** メッセージ id -> 端末に届いている画像の URL。届いていない添付は出さない。 */
const thumbs = ref<Record<string, string[]>>({})
/** サムネイルに出す最大枚数。残りは枚数で示す (原稿 03)。 */
const THUMB_LIMIT = 3
const lastReadAt = ref<string | null>(null)
const syncError = ref('')
const syncing = ref(false)

const db = openGroupDatabase(props.session.groupId)

/** 未読は端末ローカル計算のみ。既読情報はどこへも送らない(要件書 §4.10)。 */
function isUnread(message: CachedMessage): boolean {
  return lastReadAt.value === null || message.at > lastReadAt.value
}

const unreadCount = computed(() => messages.value.filter(isUnread).length)

/** 端末に控えてある画像だけを URL にする。無い添付は黙って出さない。 */
async function loadThumbs(): Promise<void> {
  for (const url of Object.values(thumbs.value).flat()) URL.revokeObjectURL(url)
  const next: Record<string, string[]> = {}
  for (const message of messages.value) {
    const urls: string[] = []
    for (const fileId of message.attachments.slice(0, THUMB_LIMIT)) {
      const file = await db.files.get(fileId)
      if (!file || !file.mediaType.startsWith('image/')) continue
      urls.push(URL.createObjectURL(new Blob([file.blob], { type: file.mediaType })))
    }
    if (urls.length > 0) next[message.id] = urls
  }
  thumbs.value = next
}

function hiddenCount(message: CachedMessage): number {
  return Math.max(0, message.attachments.length - THUMB_LIMIT)
}

/** 表示している絞り込み。「要回答」はフォームを作れるようになってから。 */
const tab = ref<'all' | 'unread'>('all')
const shown = computed(() =>
  tab.value === 'unread' ? messages.value.filter(isUnread) : messages.value,
)

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
    await loadThumbs()
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
      <div class="avatar" aria-hidden="true">{{ session.groupName.slice(0, 1) }}</div>
      <div class="titles">
        <h1>{{ session.groupName }}</h1>
        <p>{{ session.displayName }}</p>
      </div>
      <p class="badge">未読 <span data-test="unread-count">{{ unreadCount }}</span></p>
      <button type="button" class="quiet" data-test="sync" :disabled="syncing" @click="sync">
        いま同期する
      </button>
    </header>

    <!-- 担当者向けの操作。ヘッダの下に置く (デザイン 03) -->
    <slot name="actions" />

    <div class="tabs" role="group" aria-label="絞り込み">
      <button
        type="button"
        data-test="tab-all"
        :aria-pressed="tab === 'all'"
        @click="tab = 'all'"
      >
        すべて
      </button>
      <button
        type="button"
        data-test="tab-unread"
        :aria-pressed="tab === 'unread'"
        @click="tab = 'unread'"
      >
        未読 {{ unreadCount }}
      </button>
    </div>

    <p v-if="syncError" data-test="sync-error">{{ syncError }}</p>

    <p v-if="shown.length === 0" data-test="empty">
      {{ tab === 'unread' ? '未読のお知らせはありません。' : 'まだお知らせはありません。' }}
    </p>

    <ul v-else>
      <li
        v-for="message in shown"
        :key="message.id"
        data-test="message"
        :data-unread="String(isUnread(message))"
        @click="emit('open', message.id)"
      >
        <time>{{ formatWhen(message.at) }}</time>
        <h2 v-if="message.title" class="message-title">{{ message.title }}</h2>
        <p>{{ message.body }}</p>
        <div v-if="thumbs[message.id]" class="thumbs">
          <img
            v-for="(url, index) in thumbs[message.id]"
            :key="index"
            data-test="thumb"
            :src="url"
            alt=""
          />
          <span v-if="hiddenCount(message) > 0" class="thumb-more" data-test="thumb-more">
            +{{ hiddenCount(message) }}
          </span>
        </div>
        <span
          v-else-if="message.attachments.length > 0"
          data-test="has-attachment"
        >添付あり</span>
      </li>
    </ul>
  </section>
</template>
