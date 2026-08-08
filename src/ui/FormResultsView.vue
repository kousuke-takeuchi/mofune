<script setup lang="ts">
import { computed } from 'vue'
import AppBar from './AppBar.vue'
import { formatWhen } from './format'
import type { FormDefinition } from '../content/forms'
import { tally } from '../content/forms'
import type { StoredFormResponse } from '../db/group-db'
import { formResponsesToCsv } from '../content/form-results'
import type { Responder } from '../content/form-results'

const props = defineProps<{
  form: FormDefinition
  responses: StoredFormResponse[]
  /** 宛先の人数。回答率の分母。 */
  audience: number
  /** まだ答えていない人。作成者の端末でしか出せない。 */
  pending: Responder[]
  busy: boolean
  error: string
}>()
const emit = defineEmits<{ collect: []; remind: []; close: [] }>()

const result = computed(() => tally(props.form.choices, props.responses))

/**
 * 端末の中で作った data: URL。ファイルはどこへも送らずに保存される。
 * 回答は作成者しか開けないので、外へ出す経路をここに作らない。
 */
const csvHref = computed(
  () =>
    `data:text/csv;charset=utf-8,${encodeURIComponent(
      formResponsesToCsv({ question: props.form.question, responses: props.responses }),
    )}`,
)
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

    <div class="row">
      <button type="button" data-test="collect" :disabled="busy" @click="emit('collect')">
        {{ busy ? '受け取っています…' : '新しい回答を受け取る' }}
      </button>
      <a class="button-like" data-test="csv" :href="csvHref" download="回答.csv">
        表にして保存する
      </a>
    </div>

    <h2>まだ答えていない人</h2>
    <p v-if="pending.length === 0" class="hint" data-test="all-answered">
      全員から回答が届いています。
    </p>
    <template v-else>
      <ul>
        <li v-for="person in pending" :key="person.userId" data-test="pending">
          <div class="row">
            <div class="avatar" aria-hidden="true">{{ person.displayName.slice(0, 1) }}</div>
            <span class="titles">{{ person.displayName }}</span>
          </div>
        </li>
      </ul>
      <button type="button" data-test="remind" :disabled="busy" @click="emit('remind')">
        まだの {{ pending.length }} 名へ知らせる
      </button>
    </template>

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
