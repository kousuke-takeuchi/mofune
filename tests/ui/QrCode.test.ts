// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import QrCode from '../../src/ui/QrCode.vue'

describe('QrCode', () => {
  it('draws a square of modules for the text it is given', () => {
    const wrapper = mount(QrCode, { props: { text: 'https://mofune.site/app/' } })
    const svg = wrapper.find('svg')
    expect(svg.exists()).toBe(true)
    expect(svg.attributes('viewBox')).toMatch(/^0 0 \d+ \d+$/)
    expect(wrapper.findAll('rect').length).toBeGreaterThan(10)
  })

  it('grows with the amount of data rather than dropping it', () => {
    const small = mount(QrCode, { props: { text: 'a' } })
    const large = mount(QrCode, { props: { text: 'a'.repeat(400) } })
    const modulesOf = (w: typeof small): number =>
      Number(w.find('svg').attributes('viewBox')?.split(' ')[2] ?? 0)
    expect(modulesOf(large)).toBeGreaterThan(modulesOf(small))
  })

  it('carries a label for people who cannot see it', () => {
    const wrapper = mount(QrCode, { props: { text: 'x', label: '参加用のQRコード' } })
    expect(wrapper.find('svg').attributes('role')).toBe('img')
    expect(wrapper.text()).toContain('参加用のQRコード')
  })

  it('renders nothing rather than throwing when there is no text yet', () => {
    const wrapper = mount(QrCode, { props: { text: '' } })
    expect(wrapper.find('svg').exists()).toBe(false)
  })
})
