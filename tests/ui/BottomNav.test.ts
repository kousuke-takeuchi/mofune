// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BottomNav from '../../src/ui/BottomNav.vue'

describe('BottomNav', () => {
  it('offers the three places every participant needs', () => {
    const wrapper = mount(BottomNav, { props: { active: 'home' } })
    expect(wrapper.find('[data-test="nav-home"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="nav-absence"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="nav-menu"]').exists()).toBe(true)
  })

  it('marks where the visitor is now', () => {
    const wrapper = mount(BottomNav, { props: { active: 'absence' } })
    expect(wrapper.find('[data-test="nav-absence"]').attributes('aria-current')).toBe('page')
    expect(wrapper.find('[data-test="nav-home"]').attributes('aria-current')).toBeUndefined()
  })

  it('reports where the visitor wants to go', async () => {
    const wrapper = mount(BottomNav, { props: { active: 'home' } })
    await wrapper.find('[data-test="nav-menu"]').trigger('click')
    expect(wrapper.emitted('go')?.[0]).toEqual(['menu'])
  })
})
