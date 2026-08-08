// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import QrScanner from '../../src/ui/QrScanner.vue'

let mounted: VueWrapper[] = []

function camera(options: { allow?: boolean } = {}) {
  const stop = vi.fn()
  const getUserMedia = vi.fn(async () => {
    if (options.allow === false) throw new Error('Permission denied')
    return { getTracks: () => [{ stop }] } as unknown as MediaStream
  })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  return { getUserMedia, stop }
}

/** 画から文字を取り出すところだけ差し替える。カメラ無しで試すため。 */
function mountScanner(options: {
  decode?: () => string | null
  allow?: boolean
}) {
  const hardware = camera({ allow: options.allow })
  const wrapper = mount(QrScanner, {
    props: {
      decode: options.decode ?? ((): string | null => null),
      // テストでは自前で刻む
      intervalMs: 0,
    },
  })
  mounted.push(wrapper)
  return { wrapper, hardware }
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
  vi.unstubAllGlobals()
})

describe('QrScanner', () => {
  it('asks for the back camera, which is the one pointed at the paper', async () => {
    const { hardware } = mountScanner({})
    await vi.waitFor(() => expect(hardware.getUserMedia).toHaveBeenCalled(), { timeout: 2000 })
    const [constraints] = hardware.getUserMedia.mock.calls[0] as unknown as [MediaStreamConstraints]
    expect((constraints.video as MediaTrackConstraints).facingMode).toBe('environment')
  })

  it('hands over the text it read', async () => {
    const { wrapper } = mountScanner({ decode: () => 'https://mofune.site/app/#/login?c=CODE' })

    await vi.waitFor(() => expect(wrapper.emitted('read')).toBeTruthy(), { timeout: 2000 })
    expect(wrapper.emitted('read')?.[0]).toEqual(['https://mofune.site/app/#/login?c=CODE'])
  })

  it('reads only once, so the same paper is not sent twice', async () => {
    const { wrapper } = mountScanner({ decode: () => 'CODE' })
    await vi.waitFor(() => expect(wrapper.emitted('read')).toBeTruthy(), { timeout: 2000 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(wrapper.emitted('read')).toHaveLength(1)
  })

  it('turns the camera off when it is done', async () => {
    const { wrapper, hardware } = mountScanner({ decode: () => 'CODE' })
    await vi.waitFor(() => expect(wrapper.emitted('read')).toBeTruthy(), { timeout: 2000 })
    expect(hardware.stop).toHaveBeenCalled()
  })

  it('turns the camera off when the user closes it', async () => {
    const { wrapper, hardware } = mountScanner({})
    await vi.waitFor(() => expect(hardware.getUserMedia).toHaveBeenCalled(), { timeout: 2000 })
    await wrapper.get('[data-test="close-scanner"]').trigger('click')
    expect(hardware.stop).toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('explains a refusal instead of showing a black box', async () => {
    const { wrapper } = mountScanner({ allow: false })
    await vi.waitFor(() => expect(wrapper.find('[data-test="scanner-error"]').exists()).toBe(true), {
      timeout: 2000,
    })
    expect(wrapper.get('[data-test="scanner-error"]').text()).toContain('カメラ')
  })

  it('says so when the browser has no camera at all', async () => {
    vi.stubGlobal('navigator', {})
    const wrapper = mount(QrScanner, { props: { decode: (): string | null => null } })
    mounted.push(wrapper)
    await vi.waitFor(() => expect(wrapper.find('[data-test="scanner-error"]').exists()).toBe(true), {
      timeout: 2000,
    })
  })
})
