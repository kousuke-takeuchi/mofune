<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { CachedMessage } from '../db/group-db'
import { openGroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'

interface ResolvedAttachment {
  id: string
  mediaType: string
  url: string
}

const props = defineProps<{ session: Session; messageId: string }>()
const emit = defineEmits<{ back: [] }>()

const message = ref<CachedMessage | null>(null)
const attachments = ref<ResolvedAttachment[]>([])
const missingAttachments = ref<string[]>([])
const notFound = ref(false)

const db = openGroupDatabase(props.session.groupId)

function authorName(userId: string): string {
  return (
    props.session.roster.members.find((member) => member.userId === userId)?.displayName ?? '不明'
  )
}

onMounted(async () => {
  try {
    const found = await db.messages.get(props.messageId)
    if (!found) {
      notFound.value = true
      return
    }
    message.value = found

    // 添付を1件ずつ直列に待つと、呼び出し側が待つティック数に依存して
    // 表示が欠ける。既読の記録も含めて1段にまとめる。
    // 既読はローカルにだけ記録する。送出は一切しない(要件書 §4.10)。
    const [files] = await Promise.all([
      Promise.all(found.attachments.map((fileId) => db.files.get(fileId))),
      db.syncState.put({ key: 'lastReadAt', value: new Date().toISOString() }),
    ])

    found.attachments.forEach((fileId, index) => {
      const file = files[index]
      if (!file) {
        missingAttachments.value.push(fileId)
        return
      }
      const blob = new Blob([file.blob], { type: file.mediaType })
      attachments.value.push({
        id: fileId,
        mediaType: file.mediaType,
        url: URL.createObjectURL(blob),
      })
    })
  } catch {
    // 端末の登録解除(設計書 §5.4)などで DB が閉じられた場合。画面は壊さない。
  }
})

onBeforeUnmount(() => {
  for (const attachment of attachments.value) {
    URL.revokeObjectURL(attachment.url)
  }
})
</script>

<template>
  <section>
    <button type="button" class="quiet" data-test="back" @click="emit('back')">戻る</button>

    <p v-if="notFound" data-test="not-found">このお知らせは見つかりませんでした。</p>

    <article v-else-if="message">
      <p>{{ authorName(message.author) }}・{{ message.at }}</p>
      <p data-test="body">{{ message.body }}</p>

      <div v-for="attachment in attachments" :key="attachment.id">
        <img
          v-if="attachment.mediaType.startsWith('image/')"
          data-test="attachment-image"
          :src="attachment.url"
          alt=""
        />
        <a v-else data-test="attachment-link" :href="attachment.url" download>添付を開く</a>
      </div>

      <p v-for="fileId in missingAttachments" :key="fileId" data-test="attachment-missing">
        添付はまだ受信できていません。
      </p>
    </article>
  </section>
</template>
