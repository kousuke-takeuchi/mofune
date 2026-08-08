<script setup lang="ts">
import type { StoredGroup } from '../db/groups'
import type { GroupOverview } from '../db/overview'

defineProps<{
  groups: StoredGroup[]
  currentGroupId: string | null
  /**
   * グループごとの「待っていること」。端末の控えだけで数えるので、
   * 解錠していないグループのぶんも出せる (原稿 11)。
   */
  overview: Record<string, GroupOverview>
}>()
const emit = defineEmits<{ open: [groupId: string]; add: [] }>()
</script>

<template>
  <section>
    <header>
      <h1>グループの切替</h1>
      <p>この端末に記録のあるグループです</p>
    </header>

    <p v-if="groups.length === 0" data-test="empty">
      この端末にはまだどのグループの記録もありません。
    </p>

    <ul v-else>
      <li
        v-for="group in groups"
        :key="group.groupId"
        data-test="group"
        :data-current="String(group.groupId === currentGroupId)"
        @click="emit('open', group.groupId)"
      >
        <div class="row">
          <div class="avatar" aria-hidden="true">{{ group.groupName.slice(0, 1) }}</div>
          <div class="titles">
            <h2>{{ group.groupName }}</h2>
            <p class="hint">{{ group.email }}</p>
          </div>
          <div class="chips">
            <p v-if="overview[group.groupId]?.unread" class="badge">
              未読 {{ overview[group.groupId]?.unread }}
            </p>
            <p v-if="overview[group.groupId]?.needsAnswer" class="badge">
              要回答 {{ overview[group.groupId]?.needsAnswer }}
            </p>
            <p v-if="overview[group.groupId]?.unsentBatches" class="badge">
              未送信 {{ overview[group.groupId]?.unsentBatches }}
            </p>
            <p
              v-if="!overview[group.groupId]?.needsAttention && group.groupId === currentGroupId"
              class="badge"
            >
              いま開いています
            </p>
          </div>
        </div>
      </li>
    </ul>

    <button type="button" class="wide" data-test="add" @click="emit('add')">
      接続コードで参加 / 新規に作る
    </button>
  </section>
</template>
