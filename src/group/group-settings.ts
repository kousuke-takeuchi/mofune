import type { Bytes } from '../crypto/bytes'
import { fromUtf8, utf8 } from '../crypto/bytes'
import { openEnvelopeWithKey, sealEnvelope } from '../crypto/envelope'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import type { StorageProvider } from '../storage/provider'

export class GroupSettingsError extends Error {}

export const GROUP_SETTINGS_VERSION = 1

export interface MailTemplate {
  subject: string
  body: string
}

export interface NotificationSettings {
  /** 通知を止めているスコープ id。 */
  mutedScopes: string[]
  /** 既定で使うチャネル。今フェーズで実装があるのは 'mailto' のみ。 */
  channels: string[]
}

export interface GroupSettings {
  v: number
  mailTemplate: MailTemplate
  absenceReasons: string[]
  notifications: NotificationSettings
}

/**
 * 通知経路は平文なので、本文を載せられるプレースホルダを用意しない
 * (要件書 §4.5)。件名・本文は「新着がある」ことだけを伝える。
 */
export const DEFAULT_GROUP_SETTINGS: GroupSettings = {
  v: GROUP_SETTINGS_VERSION,
  mailTemplate: {
    subject: '{{グループ名}}に新着があります',
    body: '{{グループ名}}に新しい{{種別}}が届いています。\n\n{{リンク}}\n\nこのメールに本文は含まれません。アプリを開いてご確認ください。',
  },
  absenceReasons: ['体調不良', '通院', '家庭の都合'],
  notifications: { mutedScopes: [], channels: ['mailto'] },
}

export function groupSettingsPath(groupId: string): string {
  return `${groupId}/settings/templates.enc`
}

/** 許すプレースホルダはこの3つだけ。本文を差し込めるものを増やしてはならない。 */
const ALLOWED_PLACEHOLDERS = ['グループ名', 'リンク', '種別']

/**
 * 未知のプレースホルダは置換せずそのまま残す。
 * 黙って空文字にすると、意図せず中身が抜けたことに気づけない。
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  let out = template
  for (const name of ALLOWED_PLACEHOLDERS) {
    const value = values[name]
    if (value === undefined) continue
    out = out.split(`{{${name}}}`).join(value)
  }
  return out
}

export async function writeGroupSettings(options: {
  storage: StorageProvider
  groupId: string
  settings: GroupSettings
  staffKey: CryptoKey
  generation: number
}): Promise<void> {
  const sealed = await sealEnvelope(
    options.staffKey,
    keyId(STAFF_SCOPE, options.generation),
    utf8(JSON.stringify(options.settings)),
  )
  await options.storage.put(groupSettingsPath(options.groupId), sealed)
}

/** 未設定のグループは既定値で動く。開設ウィザードは Phase 2f のため。 */
export async function readGroupSettings(options: {
  storage: StorageProvider
  groupId: string
  staffKey: CryptoKey
}): Promise<GroupSettings> {
  let sealed: Bytes
  try {
    sealed = await options.storage.get(groupSettingsPath(options.groupId))
  } catch {
    return DEFAULT_GROUP_SETTINGS
  }

  let plaintext: Bytes
  try {
    plaintext = await openEnvelopeWithKey(options.staffKey, sealed)
  } catch {
    throw new GroupSettingsError('group settings could not be decrypted with this key')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(plaintext))
  } catch {
    throw new GroupSettingsError('group settings are not valid JSON')
  }
  const settings = parsed as GroupSettings
  if (
    settings === null ||
    typeof settings !== 'object' ||
    settings.mailTemplate === null ||
    typeof settings.mailTemplate !== 'object' ||
    !Array.isArray(settings.absenceReasons) ||
    settings.notifications === null ||
    typeof settings.notifications !== 'object'
  ) {
    throw new GroupSettingsError('group settings are missing required fields')
  }
  return settings
}
