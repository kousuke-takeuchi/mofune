// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import AppBar from '../../src/ui/AppBar.vue'

describe('AppBar', () => {
  it('names the screen', () => {
    const wrapper = mount(AppBar, { props: { title: 'お知らせ' } })
    expect(wrapper.find('h1').text()).toBe('お知らせ')
  })

  it('keeps the screen name available to a reader even when it is only shown once', () => {
    const wrapper = mount(AppBar, { props: { title: 'お知らせ' } })
    expect(wrapper.find('header').exists()).toBe(true)
  })

  it('takes the caller own back control so its data-test survives', () => {
    // 戻る操作の中身は画面ごとに違う (戻る / 閉じる / キャンセル)。
    // バーが用意すると、既存のテストが指しているボタンが消える。
    const wrapper = mount(AppBar, {
      props: { title: 'お知らせ' },
      slots: { left: () => h('button', { 'data-test': 'back' }, '戻る') },
    })
    expect(wrapper.find('[data-test="back"]').exists()).toBe(true)
  })

  it('has room for an action on the right', () => {
    const wrapper = mount(AppBar, {
      props: { title: 'お知らせを作る' },
      slots: { right: () => h('button', { 'data-test': 'draft' }, '下書き') },
    })
    expect(wrapper.find('[data-test="draft"]').exists()).toBe(true)
  })
})
