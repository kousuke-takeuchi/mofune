<script setup lang="ts">
import { computed } from 'vue'
import AppBar from './AppBar.vue'
import { formatWhen } from './format'
import type { FormDefinition } from '../content/forms'
import { tally } from '../content/forms'
import type { StoredFormResponse } from '../db/group-db'

const props = defineProps<{
  form: FormDefinition
  responses: StoredFormResponse[]
  /** 名簿にいる人数。回答率の分母。 */
  audience: number
  busy: boolean
  error: string
}>()
const emit = defineEmits<{ collect: []; close: [] }>()

const result = computed(() => tally(props.form.choices, props.responses))
</script>

<template>
  <section>
    <AppBar title="回答の集計">
      <template #left>
        <button type="button" class="quiet" data-test="close" @click="emit('close')">閉じる</button>
      </template>
    </AppBar>

    <p v-if="error" data-test="error">{{ error }}</p>

    <h2>{{ form.question }}</h2>
    <p v-if="form.dueAt" class="hint">締切 {{ formatWhen(form.dueAt) }}</p>

    <p data-test="answered">{{ result.answered }} / {{ audience }} 人が回答</p>

    <ul>
      <li v-for="entry in result.counts" :key="entry.choice" data-test="count">
        <div class="row">
          <span class="titles">{{ entry.choice }}</span>
          <span class="badge">{{ entry.count }}</span>
        </div>
      </li>
    </ul>

    <p class="hint">
      集計はこの端末にだけあります。回答はあなたの鍵で開いたもので、ほかの端末や
      ほかの担当者からは見えません。
    </p>

    <button type="button" data-test="collect" :disabled="busy" @click="emit('collect')">
      {{ busy ? '受け取っています…' : '新しい回答を受け取る' }}
    </button>

    <h2>回答した人</h2>
    <p v-if="responses.length === 0" data-test="empty">まだ回答はありません。</p>
    <ul v-else>
      <li v-for="response in responses" :key="response.id" data-test="response">
        <div class="row">
          <div class="avatar" aria-hidden="true">{{ response.displayName.slice(0, 1) }}</div>
          <div class="titles">
            <h3>{{ response.displayName }}</h3>
            <p class="hint">{{ response.choice }}<template v-if="response.note"> · {{ response.note }}</template></p>
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>
