<script setup lang="ts">
import type { StoredGroup } from '../db/groups'

defineProps<{ groups: StoredGroup[]; currentGroupId: string | null }>()
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
            <p class="hint">{{ group.loginId }}</p>
          </div>
          <p v-if="group.groupId === currentGroupId" class="badge">いま開いています</p>
        </div>
      </li>
    </ul>

    <button type="button" class="wide" data-test="add" @click="emit('add')">
      接続コードで参加 / 新規に作る
    </button>
  </section>
</template>
