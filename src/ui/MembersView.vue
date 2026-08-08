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
  createSubgroup: [subgroup: { name: string; parent: string | null }]
  move: [target: { userId: string; scopes: string[] }]
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
const moving = ref<RosterMember | null>(null)
const movingScopes = ref<Record<string, boolean>>({})
const subgroupName = ref('')
const subgroupParent = ref<string>('')
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

function createSubgroup(): void {
  if (!subgroupName.value.trim()) return
  emit('createSubgroup', {
    name: subgroupName.value.trim(),
    parent: subgroupParent.value === '' ? null : subgroupParent.value,
  })
  subgroupName.value = ''
  subgroupParent.value = ''
}

function startMove(member: RosterMember): void {
  moving.value = member
  movingScopes.value = Object.fromEntries(
    props.roster.subgroups.map((group) => [group.id, member.scopes.includes(group.id)]),
  )
}

function confirmMove(): void {
  if (!moving.value) return
  emit('move', {
    userId: moving.value.userId,
    scopes: Object.entries(movingScopes.value)
      .filter(([, on]) => on)
      .map(([id]) => id),
  })
  moving.value = null
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
          <button type="button" class="quiet" data-test="edit-scopes" @click="startMove(member)">
            所属
          </button>
          <button type="button" class="quiet" data-test="reissue" @click="startReissue(member)">
            再発行
          </button>
        </div>
      </li>
    </ul>

    <template v-if="moving">
      <h2>{{ moving.displayName }} の所属</h2>
      <p class="hint">
        外しても、その人の端末にある鍵は取り上げられません。<strong>これまでに配られた
        内容は読めるまま</strong>です。本当に読ませたくないときは鍵の入れ替えが要ります。
      </p>
      <fieldset>
        <legend>所属するサブグループ</legend>
        <label v-for="group in roster.subgroups" :key="group.id">
          <input
            type="checkbox"
            data-test="move-option"
            :data-scope="group.id"
            v-model="movingScopes[group.id]"
          />
          {{ group.name }}
        </label>
      </fieldset>
      <div class="row">
        <button
          type="button"
          class="primary"
          data-test="move-confirm"
          :disabled="busy"
          @click="confirmMove"
        >
          この所属にする
        </button>
        <button type="button" class="quiet" data-test="move-cancel" @click="moving = null">
          やめる
        </button>
      </div>
    </template>

    <h2>サブグループ</h2>
    <ul v-if="roster.subgroups.length > 0">
      <li v-for="group in roster.subgroups" :key="group.id" data-test="subgroup">
        <h3>{{ group.name }}</h3>
        <p v-if="group.parent" class="hint">{{ subgroupNames[group.parent] }} の中</p>
      </li>
    </ul>
    <p v-else class="hint">まだサブグループはありません。</p>

    <label>
      新しいサブグループの名前
      <input data-test="new-subgroup-name" v-model="subgroupName" />
    </label>
    <label>
      どこの中に作るか
      <select data-test="new-subgroup-parent" v-model="subgroupParent">
        <option value="">グループの直下</option>
        <option v-for="group in roster.subgroups" :key="group.id" :value="group.id">
          {{ group.name }} の中
        </option>
      </select>
    </label>
    <button
      type="button"
      data-test="create-subgroup"
      :disabled="busy"
      @click="createSubgroup"
    >
      サブグループを作る
    </button>

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
