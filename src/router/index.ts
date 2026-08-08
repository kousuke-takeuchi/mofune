import { createRouter, createWebHashHistory } from 'vue-router'
import type { Router, RouteRecordRaw } from 'vue-router'
import { useGroupsStore } from '../stores/groups'
import { useSessionStore } from '../stores/session'

declare module 'vue-router' {
  interface RouteMeta {
    /** セッションが無くても開ける */
    public?: boolean
    /** 参加者には開かせない */
    staffOnly?: boolean
    /** 管理者だけ。名簿の再署名を伴う操作 */
    adminOnly?: boolean
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('../pages/HomePage.vue'),
    meta: { public: true },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('../pages/LoginPage.vue'),
    meta: { public: true },
  },
  {
    path: '/unlock',
    name: 'unlock',
    component: () => import('../pages/UnlockPage.vue'),
    meta: { public: true },
  },
  {
    // 紙の復元コードから管理者のログインを作り直す。セッションは要らない。
    path: '/recover',
    name: 'recover',
    component: () => import('../pages/RecoverPage.vue'),
    meta: { public: true },
  },
  {
    path: '/provision',
    name: 'provision',
    component: () => import('../pages/ProvisionPage.vue'),
    meta: { public: true },
  },
  { path: '/g/:groupId', name: 'timeline', component: () => import('../pages/TimelinePage.vue') },
  {
    path: '/g/:groupId/messages/:messageId',
    name: 'message',
    component: () => import('../pages/MessagePage.vue'),
  },
  {
    path: '/g/:groupId/messages/:messageId/results',
    name: 'results',
    component: () => import('../pages/FormResultsPage.vue'),
    meta: { staffOnly: true },
  },
  {
    path: '/g/:groupId/messages/:messageId/notify',
    name: 'notify',
    component: () => import('../pages/NotifyPage.vue'),
    meta: { staffOnly: true },
  },
  {
    path: '/g/:groupId/compose',
    name: 'compose',
    component: () => import('../pages/ComposePage.vue'),
    meta: { staffOnly: true },
  },
  {
    path: '/g/:groupId/absence',
    name: 'absence',
    component: () => import('../pages/AbsencePage.vue'),
  },
  {
    path: '/g/:groupId/absences',
    name: 'absences',
    component: () => import('../pages/AbsenceListPage.vue'),
    meta: { staffOnly: true },
  },
  {
    path: '/g/:groupId/panel',
    name: 'panel',
    component: () => import('../pages/PanelPage.vue'),
    meta: { staffOnly: true },
  },
  { path: '/g/:groupId/setup', name: 'setup', component: () => import('../pages/SetupPage.vue') },
  {
    path: '/g/:groupId/members',
    name: 'members',
    component: () => import('../pages/MembersPage.vue'),
    meta: { adminOnly: true },
  },
  {
    path: '/g/:groupId/group-settings',
    name: 'group-settings',
    component: () => import('../pages/GroupSettingsPage.vue'),
    meta: { staffOnly: true },
  },
  {
    path: '/g/:groupId/settings',
    name: 'settings',
    component: () => import('../pages/SettingsPage.vue'),
  },
  {
    // 端末の記録を並べるだけでセッションは要らない。開く段でガードが解錠を求める。
    path: '/groups',
    name: 'groups',
    component: () => import('../pages/GroupsPage.vue'),
    meta: { public: true },
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'home' } },
]

/**
 * 戻り先はアプリ内の相対パスだけ受け付ける。細工したリンクで
 * 別サイトへ飛ばされないようにするため。
 */
export function safeNext(next: unknown): string | null {
  if (typeof next !== 'string') return null
  if (!next.startsWith('/')) return null
  if (next.startsWith('//')) return null
  return next
}

export function installGuards(router: Router): void {
  router.beforeEach(async (to) => {
    const session = useSessionStore()

    if (to.name === 'home') {
      const groups = useGroupsStore()
      await groups.load()
      const groupId = groups.lastGroupId
      if (!groupId) return { name: 'login' }
      if (session.isSignedIn && session.groupId === groupId) {
        return { name: 'timeline', params: { groupId } }
      }
      return { name: 'unlock', query: { next: `/g/${groupId}` } }
    }

    if (to.meta.public) return true

    const groupId = String(to.params.groupId ?? '')

    if (!session.isSignedIn || session.groupId !== groupId) {
      const groups = useGroupsStore()
      await groups.load()
      const known = groups.groups.some((group) => group.groupId === groupId)
      const query = { next: to.fullPath }
      return known ? { name: 'unlock', query } : { name: 'login', query }
    }

    if (to.meta.staffOnly && session.role === 'member') {
      return { name: 'timeline', params: { groupId } }
    }

    // 名簿を再署名できるのは管理者だけ。ほかの人が開いても何もできない。
    if (to.meta.adminOnly && session.role !== 'admin') {
      return { name: 'timeline', params: { groupId } }
    }

    // メールアドレス未登録の参加者は、登録が済むまで主要機能をロックする(要件書 §4.6)
    if (session.role === 'member' && !session.emailConfirmed && to.name !== 'setup') {
      return { name: 'setup', params: { groupId } }
    }

    return true
  })
}

/**
 * hash history を使う。GitHub Pages は SPA のフォールバックを持たないため、
 * history mode だと直接アクセスとリロードが 404 になる。
 */
export function createAppRouter(): Router {
  const router = createRouter({ history: createWebHashHistory(), routes })
  installGuards(router)
  return router
}
