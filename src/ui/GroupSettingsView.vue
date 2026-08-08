<script setup lang="ts">
import { computed, ref } from 'vue'
import AppBar from './AppBar.vue'
import type { Subgroup } from '../crypto/roster'
import { ALL_SCOPE } from '../crypto/roster'
import type { GroupSettings } from '../group/group-settings'

const props = defineProps<{
  settings: GroupSettings
  subgroups: Subgroup[]
  busy: boolean
  error: string
  notice: string
  /** manifest に入っている通知用の関数の URL。置いていなければ空。 */
  functionUrl?: string
}>()
const emit = defineEmits<{
  save: [settings: GroupSettings, functionUrl: string]
  close: []
}>()

const reasons = ref<string[]>([...props.settings.absenceReasons])
const newReason = ref('')
const subject = ref(props.settings.mailTemplate.subject)
const body = ref(props.settings.mailTemplate.body)
const functionUrl = ref(props.functionUrl ?? '')
const functionToken = ref(props.settings.notifications.functionToken)
const muted = ref<Record<string, boolean>>(
  Object.fromEntries(props.settings.notifications.mutedScopes.map((scope) => [scope, true])),
)

/** テンプレの二重波括弧はコンパイラが式として読んでしまう。script 側で作る。 */
const PLACEHOLDERS = ['グループ名', '種別', 'リンク'].map((name) => `{{${name}}}`)

/** 通知を止められる単位。グループ全体も含める。 */
const mutable = computed(() => [
  { id: ALL_SCOPE, name: 'グループ全体' },
  ...props.subgroups.map((group) => ({ id: group.id, name: group.name })),
])

function addReason(): void {
  const value = newReason.value.trim()
  if (!value || reasons.value.includes(value)) return
  reasons.value.push(value)
  newReason.value = ''
}

function removeReason(index: number): void {
  reasons.value.splice(index, 1)
}

function save(): void {
  emit(
    'save',
    {
      ...props.settings,
      absenceReasons: [...reasons.value],
      mailTemplate: { subject: subject.value, body: body.value },
      notifications: {
        ...props.settings.notifications,
        mutedScopes: mutable.value
          .filter((entry) => muted.value[entry.id])
          .map((entry) => entry.id),
        functionToken: functionToken.value.trim(),
      },
    },
    functionUrl.value.trim(),
  )
}
</script>

<template>
  <section>
    <AppBar title="グループの設定">
      <template #left>
        <button type="button" class="quiet" data-test="close" @click="emit('close')">閉じる</button>
      </template>
    </AppBar>

    <p v-if="error" data-test="error">{{ error }}</p>
    <p v-if="notice" data-test="notice" class="hint">{{ notice }}</p>

    <h2>よく使う理由</h2>
    <p class="hint">れんらくの画面で、押すだけで選べるようにします。</p>
    <ul v-if="reasons.length > 0">
      <li v-for="(reason, index) in reasons" :key="reason" data-test="reason">
        <div class="row">
          <span class="titles">{{ reason }}</span>
          <button
            type="button"
            class="quiet danger"
            data-test="remove-reason"
            @click="removeReason(index)"
          >
            外す
          </button>
        </div>
      </li>
    </ul>
    <label>
      足す理由
      <input data-test="new-reason" v-model="newReason" />
    </label>
    <button type="button" data-test="add-reason" @click="addReason">理由を足す</button>

    <h2>通知のメール</h2>
    <p class="hint">
      使えるのは <code v-for="name in PLACEHOLDERS" :key="name">{{ name }}</code>
      の3つだけです。メールは経路が平文なので、<strong>お知らせの本文は載せません</strong>。
    </p>
    <label>
      件名
      <input data-test="mail-subject" v-model="subject" />
    </label>
    <label>
      本文
      <textarea data-test="mail-body" v-model="body"></textarea>
    </label>

    <h2>通知の関数 (任意)</h2>
    <p class="hint">
      置くと、お知らせを出したときに参加者の端末へ通知が届きます。置かなくても
      すべての機能が動きます。合言葉は担当者と管理者だけが読めます。
    </p>
    <label>
      関数の URL
      <input data-test="function-url" v-model="functionUrl" placeholder="https://..." />
    </label>
    <label>
      合言葉
      <input data-test="function-token" v-model="functionToken" />
    </label>

    <h2>通知を止める</h2>
    <p class="hint">止めた宛先には、メールの下書きを作りません。</p>
    <fieldset>
      <legend>止める宛先</legend>
      <label v-for="entry in mutable" :key="entry.id">
        <input
          type="checkbox"
          data-test="mute-option"
          :data-scope="entry.id"
          v-model="muted[entry.id]"
        />
        {{ entry.name }}
      </label>
    </fieldset>

    <button type="button" class="primary" data-test="save" :disabled="busy" @click="save">
      保存する
    </button>
  </section>
</template>
