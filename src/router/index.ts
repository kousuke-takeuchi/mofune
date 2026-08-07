import { createRouter, createWebHashHistory } from 'vue-router'
import type { Router, RouteRecordRaw } from 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    /** セッションが無くても開ける */
    public?: boolean
    /** 参加者には開かせない */
    staffOnly?: boolean
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
  { path: '/:pathMatch(.*)*', redirect: { name: 'home' } },
]

/**
 * hash history を使う。GitHub Pages は SPA のフォールバックを持たないため、
 * history mode だと直接アクセスとリロードが 404 になる。
 */
export function createAppRouter(): Router {
  return createRouter({ history: createWebHashHistory(), routes })
}
