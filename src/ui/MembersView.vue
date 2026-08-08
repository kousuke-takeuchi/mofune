<script setup lang="ts">
import { computed, ref } from 'vue'
import AppBar from './AppBar.vue'
import type { Role, RosterContents, RosterMember } from '../crypto/roster'

const props = defineProps<{
  roster: RosterContents
  busy: boolean
  error: string
  notice: string
}>()
const emit = defineEmits<{
  add: [member: { displayName: string; loginId: string; role: Role; scopes: string[]; password: string; email: string }]
  reissue: [target: { userId: string; loginId: string; password: string }]
  close: []
}>()

const ROLE_LABELS: Record<Role, string> = {
  admin: '管理者',
  staff: '担当者',
  member: '参加者',
}

const displayName = ref('')
const loginId = ref('')
const role = ref<Role>('member')
const password = ref('')
const email = ref('')
const selected = ref<Record<string, boolean>>({})
const formError = ref('')

const reissuing = ref<RosterMember | null>(null)
const reissueLoginId = ref('')
const reissuePassword = ref('')

const subgroupNames = computed(() =>
  Object.fromEntries(props.roster.subgroups.map((group) => [group.id, group.name])),
)

/** 名簿の scopes には all と staff も入っている。人に見せるのはサブグループだけ。 */
function placesOf(member: RosterMember): string {
  const names = member.scopes
    .map((scope) => subgroupNames.value[scope])
    .filter((name): name is string => Boolean(name))
  return names.length > 0 ? names.join('・') : '未所属'
}

function add(): void {
  formError.value = ''
  if (!displayName.value.trim() || !loginId.value.trim() || !password.value) {
    formError.value = '表示名・ログインID・初期パスワードを入れてください'
    return
  }
  emit('add', {
    displayName: displayName.value.trim(),
    loginId: loginId.value.trim(),
    role: role.value,
    scopes: Object.entries(selected.value)
      .filter(([, on]) => on)
      .map(([id]) => id),
    password: password.value,
    email: email.value.trim(),
  })
  displayName.value = ''
  loginId.value = ''
  password.value = ''
  email.value = ''
  selected.value = {}
}

function startReissue(member: RosterMember): void {
  reissuing.value = member
  reissueLoginId.value = ''
  reissuePassword.value = ''
}

function confirmReissue(): void {
  if (!reissuing.value || !reissueLoginId.value.trim() || !reissuePassword.value) return
  emit('reissue', {
    userId: reissuing.value.userId,
    loginId: reissueLoginId.value.trim(),
    password: reissuePassword.value,
  })
  reissuing.value = null
}
</script>

<template>
  <section>
    <AppBar title="メンバー">
      <template #left>
        <button type="button" class="quiet" data-test="close" @click="emit('close')">閉じる</button>
      </template>
    </AppBar>

    <p v-if="error" data-test="error">{{ error }}</p>
    <p v-if="notice" data-test="notice" class="hint">{{ notice }}</p>

    <h2>いまのメンバー</h2>
    <ul>
      <li v-for="member in roster.members" :key="member.userId" data-test="member">
        <div class="row">
          <div class="avatar" aria-hidden="true">{{ member.displayName.slice(0, 1) }}</div>
          <div class="titles">
            <h3>{{ member.displayName }}</h3>
            <p class="hint">{{ ROLE_LABELS[member.role] }} · {{ placesOf(member) }}</p>
          </div>
          <button type="button" class="quiet" data-test="reissue" @click="startReissue(member)">
            パスワード再発行
          </button>
        </div>
      </li>
    </ul>

    <template v-if="reissuing">
      <h2>{{ reissuing.displayName }} のパスワードを再発行</h2>
      <p class="hint">
        いまのパスワードは<strong>使えなくなります</strong>。鍵も作り直すため、その人の端末に
        残っている未送信の連絡は送れなくなります。忘れたときだけ使ってください。
      </p>
      <label>
        その人のログインID
        <input data-test="reissue-login-id" v-model="reissueLoginId" />
      </label>
      <label>
        新しい初期パスワード
        <input data-test="reissue-password" v-model="reissuePassword" />
      </label>
      <div class="row">
        <button
          type="button"
          class="primary"
          data-test="reissue-confirm"
          :disabled="busy"
          @click="confirmReissue"
        >
          再発行する
        </button>
        <button type="button" class="quiet" data-test="reissue-cancel" @click="reissuing = null">
          やめる
        </button>
      </div>
    </template>

    <h2>メンバーを追加</h2>
    <p class="hint">
      初期パスワードは管理者が決めて紙で渡します。追加した人は<strong>過去のお知らせも読めます</strong>。
    </p>

    <label>
      表示名
      <input data-test="new-display-name" v-model="displayName" />
    </label>
    <label>
      ログインID
      <input data-test="new-login-id" v-model="loginId" />
    </label>
    <label>
      役割
      <select data-test="new-role" v-model="role">
        <option value="member">参加者</option>
        <option value="staff">担当者</option>
      </select>
    </label>
    <label>
      初期パスワード
      <input data-test="new-password" v-model="password" />
    </label>
    <label>
      メールアドレス
      <input type="email" data-test="new-email" v-model="email" />
    </label>

    <fieldset v-if="roster.subgroups.length > 0">
      <legend>所属するサブグループ</legend>
      <label v-for="group in roster.subgroups" :key="group.id">
        <input
          type="checkbox"
          data-test="scope-option"
          :data-scope="group.id"
          v-model="selected[group.id]"
        />
        {{ group.name }}
      </label>
    </fieldset>

    <p v-if="formError" data-test="form-error">{{ formError }}</p>

    <button type="button" class="primary" data-test="add" :disabled="busy" @click="add">
      追加する
    </button>
  </section>
</template>
