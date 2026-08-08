import { defineStore } from 'pinia'
import type { StoredGroup } from '../db/groups'
import { forgetGroup, listGroups } from '../db/groups'

/** 端末に記録済みのグループ。接続コードとメールアドレスだけで、秘密は含まない。 */
export const useGroupsStore = defineStore('groups', {
  state: () => ({ groups: [] as StoredGroup[] }),
  getters: {
    lastGroupId(state): string | null {
      return state.groups[0]?.groupId ?? null
    },
  },
  actions: {
    async load(): Promise<void> {
      this.groups = await listGroups()
    },
    async forget(groupId: string): Promise<void> {
      await forgetGroup(groupId)
      await this.load()
    },
  },
})
