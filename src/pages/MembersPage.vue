<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import MembersView from '../ui/MembersView.vue'
import type { RosterContents } from '../crypto/roster'
import type { NewMemberInput } from '../group/membership'
import { addMember, reissuePassword } from '../group/membership'
import { moveEveryone } from '../group/bulk-move'
import { removeMember } from '../group/rotation'
import { createSubgroup, setMemberScopes } from '../group/subgroups'
import { getGroup } from '../db/groups'
import type { ConnectionCode } from '../group/connection-code'
import { encodeConnectionCode } from '../group/connection-code'
import type { StorageSettings } from '../group/storage-credentials'
import { readStorageSettings } from '../group/storage-credentials'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()

const roster = ref<RosterContents | null>(null)
const code = ref<ConnectionCode | null>(null)
const settings = ref<StorageSettings | null>(null)
const busy = ref(false)
const error = ref('')
const notice = ref('')

onMounted(async () => {
  roster.value = session.session?.roster ?? null
  const groupId = session.groupId
  if (!groupId || !session.session || !session.storage) return
  code.value = (await getGroup(groupId))?.code ?? null
  try {
    settings.value = await readStorageSettings({
      storage: session.storage,
      groupId,
      keys: session.session.groupKeys,
    })
  } catch {
    error.value = '書き込みの資格情報を読めませんでした'
  }
})

/** 変更のあと、名簿を持っているセッションも新しくする。 */
async function refresh(): Promise<void> {
  if (!session.session || !session.storage || !code.value) return
  const { verifyRoster, parseRosterFile } = await import('../crypto/roster')
  const { fromBase64 } = await import('../crypto/bytes')
  const { rosterPath } = await import('../storage/paths')
  const file = parseRosterFile(await session.storage.get(rosterPath(session.session.groupId)))
  const next = await verifyRoster(file, fromBase64(code.value.adminPublicKey))
  session.session = { ...session.session, roster: next }
  roster.value = next
}

async function onAdd(member: NewMemberInput): Promise<void> {
  if (!session.session || !session.writer || !code.value || !settings.value) return
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    await addMember({
      storage: session.writer,
      session: session.session,
      code: code.value,
      settings: settings.value,
      member,
    })
    await refresh()
    notice.value = `${member.displayName} さんを追加しました。接続コードと初期パスワードを紙で渡してください。`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '追加できませんでした'
  } finally {
    busy.value = false
  }
}

async function onCreateSubgroup(input: { name: string; parent: string | null }): Promise<void> {
  if (!session.session || !session.writer || !code.value) return
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    await createSubgroup({
      storage: session.writer,
      session: session.session,
      code: code.value,
      ...input,
    })
    await refresh()
    notice.value = `${input.name} を作りました。`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '作れませんでした'
  } finally {
    busy.value = false
  }
}

async function onMove(target: { userId: string; scopes: string[] }): Promise<void> {
  if (!session.session || !session.writer || !code.value || !settings.value) return
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    await setMemberScopes({
      storage: session.writer,
      session: session.session,
      code: code.value,
      settings: settings.value,
      ...target,
    })
    await refresh()
    notice.value = '所属を変えました。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '変えられませんでした'
  } finally {
    busy.value = false
  }
}

/**
 * 外したあとは鍵の世代が上がる。いまのセッションは古い世代のままなので、
 * 入り直してもらう。黙って古い鍵で書き続けると、誰も読めないお知らせができる。
 */
async function onBulkMove(move: { from: string; to: string }): Promise<void> {
  if (!session.session || !session.writer || !code.value || !settings.value) return
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    const { moved } = await moveEveryone({
      storage: session.writer,
      session: session.session,
      code: code.value,
      settings: settings.value,
      ...move,
    })
    await refresh()
    notice.value = `${moved.length}人を移しました。`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '移せませんでした'
  } finally {
    busy.value = false
  }
}

async function onRemove(target: { userId: string }): Promise<void> {
  if (!session.session || !session.writer || !code.value || !settings.value) return
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    await removeMember({
      storage: session.writer,
      session: session.session,
      code: code.value,
      settings: settings.value,
      userId: target.userId,
    })
    session.signOut()
    await router.push({ name: 'unlock', query: { next: `/g/${code.value.groupId}` } })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '外せませんでした'
    busy.value = false
  }
}

async function onReissue(target: {
  userId: string
  email: string
  password: string
}): Promise<void> {
  if (!session.session || !session.writer || !code.value || !settings.value) return
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    await reissuePassword({
      storage: session.writer,
      session: session.session,
      code: code.value,
      settings: settings.value,
      ...target,
    })
    await refresh()
    notice.value = '新しいパスワードを紙で渡してください。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '再発行できませんでした'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <MembersView
    v-if="roster"
    :roster="roster"
    :busy="busy"
    :error="error"
    :notice="notice"
    @add="onAdd"
    :current-user-id="session.session?.userId ?? ''"
    :connection-code="code ? encodeConnectionCode(code) : undefined"
    @create-subgroup="onCreateSubgroup"
    @remove="onRemove"
    @bulk-move="onBulkMove"
    @move="onMove"
    @reissue="onReissue"
    @close="router.push({ name: 'timeline', params: { groupId: session.groupId } })"
  />
</template>
