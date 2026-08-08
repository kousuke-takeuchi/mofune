// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { createAppRouter } from '../../src/router'

describe('routes', () => {
  it('uses hash urls so a reload does not 404 on github pages', () => {
    expect(createAppRouter().resolve({ name: 'login' }).href).toBe('#/login')
  })

  it('maps every screen to a url', () => {
    const paths = createAppRouter()
      .getRoutes()
      .map((route) => route.path)
      .sort()
    expect(paths).toEqual(
      [
        '/',
        '/g/:groupId',
        '/g/:groupId/absence',
        '/g/:groupId/absences',
        '/g/:groupId/compose',
        '/g/:groupId/messages/:messageId',
        '/g/:groupId/messages/:messageId/notify',
        '/g/:groupId/messages/:messageId/results',
        '/g/:groupId/panel',
        '/g/:groupId/group-settings',
        '/g/:groupId/members',
        '/g/:groupId/settings',
        '/g/:groupId/setup',
        '/groups',
        '/login',
        '/provision',
        '/unlock',
        '/:pathMatch(.*)*',
      ].sort(),
    )
  })

  it('names the screens the pages navigate to', () => {
    const names = createAppRouter()
      .getRoutes()
      .map((route) => route.name)
      .filter((name): name is string => typeof name === 'string')
    for (const name of [
      'home',
      'login',
      'unlock',
      'provision',
      'timeline',
      'message',
      'notify',
      'compose',
      'absence',
      'absences',
      'panel',
      'setup',
      'settings',
      'members',
      'group-settings',
      'groups',
    ]) {
      expect(names).toContain(name)
    }
  })

  it('marks the screens that only staff may open', () => {
    const staffOnly = createAppRouter()
      .getRoutes()
      .filter((route) => route.meta.staffOnly)
      .map((route) => route.name)
    expect(staffOnly.sort()).toEqual([
      'absences',
      'compose',
      'group-settings',
      'notify',
      'panel',
      'results',
    ])
  })

  it('marks the screens that do not need a session', () => {
    const publicNames = createAppRouter()
      .getRoutes()
      .filter((route) => route.meta.public)
      .map((route) => route.name)
    expect(publicNames.sort()).toEqual(['groups', 'home', 'login', 'provision', 'unlock'])
  })
})
