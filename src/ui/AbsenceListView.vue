<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { CachedAbsence } from '../db/group-db'
import { openGroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'

const props = defineProps<{ session: Session }>()
const emit = defineEmits<{ close: [] }>()

const KIND_LABELS: Record<string, string> = {
  absent: '欠席',
  late: '遅れます',
  early: '早く帰ります',
}

const absences = ref<CachedAbsence[]>([])
const loaded = ref(false)

// 参加者に見せると他人の欠席理由まで見えてしまう
const allowed = props.session.role !== 'member'

function authorName(userId: string): string {
  return (
    props.session.roster.members.find((member) => member.userId === userId)?.displayName ??
    '不明'
  )
}

onMounted(async () => {
  if (!allowed) {
    loaded.value = true
    return
  }
  try {
    const rows = await openGroupDatabase(props.session.groupId).absences.toArray()
    absences.value = rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  } catch {
    // DB が閉じられている場合は空のまま表示する
  } finally {
    loaded.value = true
  }
})
</script>

<template>
  <section v-if="loaded">
    <h1>届いた連絡</h1>
    <button type="button" class="quiet" data-test="close" @click="emit('close')">閉じる</button>

    <p v-if="!allowed" data-test="not-allowed">
      届いた連絡を見られるのは担当者と管理者だけです。
    </p>

    <div v-else data-test="ready">
      <p v-if="absences.length === 0" data-test="empty">まだ届いていません。</p>
      <ul v-else>
        <li v-for="absence in absences" :key="absence.id" data-test="absence">
          <p>{{ absence.date }}・{{ KIND_LABELS[absence.kind] ?? absence.kind }}</p>
          <p>{{ authorName(absence.author) }}</p>
          <p v-if="absence.reason">{{ absence.reason }}</p>
          <p v-if="absence.note">{{ absence.note }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>
