import { describe, it, expect } from 'vitest'
import jsQR from 'jsqr'
import qrcode from 'qrcode-generator'
import { buildJoinUrl } from '../../src/group/join-url'

/**
 * 印刷する QR が本当に読めるかを、アプリに同梱した読み取り器で確かめる。
 *
 * ひとりぶんの情報をまとめた QR は密度が高い。作れることと読めることは別なので、
 * 「1マス何 px なら読めるか」をここで固定する。画面や紙が小さすぎると、
 * 作れているのに誰も読めない QR を配ることになる。
 */

/** モジュールの並びを、そのまま RGBA の画素にする (canvas は使わない)。 */
function render(text: string, scale: number, correction: 'L' | 'M' = 'M', quietZone = 4) {
  const qr = qrcode(0, correction)
  qr.addData(text)
  qr.make()
  const count = qr.getModuleCount()
  // 四隅の余白 (クワイエットゾーン) が無いと読み取れない
  const quiet = quietZone
  const side = (count + quiet * 2) * scale
  const data = new Uint8ClampedArray(side * side * 4).fill(255)

  for (let y = 0; y < count; y += 1) {
    for (let x = 0; x < count; x += 1) {
      if (!qr.isDark(y, x)) continue
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = (x + quiet) * scale + dx
          const py = (y + quiet) * scale + dy
          const at = (py * side + px) * 4
          data[at] = 0
          data[at + 1] = 0
          data[at + 2] = 0
        }
      }
    }
  }
  return { data, side, modules: count }
}

const CODE = 'x'.repeat(330)

describe('the QR handed to one participant', () => {
  const url = buildJoinUrl(CODE, 'https://mofune.site/app/', {
    email: 'sato@example.com',
    password: 'first-pass-1234',
  })

  it('is dense, so the paper cannot be tiny', () => {
    const { modules } = render(url, 1)
    // 版 19 前後。1マス 1px では携帯のカメラは追えない
    expect(modules).toBeGreaterThan(80)
  })

  it('reads back exactly what was put in, at 4px per module', () => {
    const { data, side } = render(url, 4)
    expect(jsQR(data, side, side, { inversionAttempts: 'attemptBoth' })?.data).toBe(url)
  })

  it('still reads at 3px per module, which is the size we print at', () => {
    const { data, side } = render(url, 3)
    expect(jsQR(data, side, side, { inversionAttempts: 'attemptBoth' })?.data).toBe(url)
  })
})

describe('the QR for the whole group (code only)', () => {
  const url = buildJoinUrl(CODE, 'https://mofune.site/app/')

  it('is smaller than the one that carries a login', () => {
    expect(render(url, 1).modules).toBeLessThan(render(
      buildJoinUrl(CODE, 'https://mofune.site/app/', {
        email: 'sato@example.com',
        password: 'first-pass-1234',
      }),
      1,
    ).modules)
  })

  it('reads back exactly what was put in', () => {
    const { data, side } = render(url, 4)
    expect(jsQR(data, side, side, { inversionAttempts: 'attemptBoth' })?.data).toBe(url)
  })
})

describe('the quiet zone', () => {
  const url = buildJoinUrl(CODE, 'https://mofune.site/app/')

  it('does not stop this decoder, but the margin is still what the spec asks for', () => {
    const withMargin = render(url, 4, 'M', 4)
    const without = render(url, 4, 'M', 0)

    expect(jsQR(withMargin.data, withMargin.side, withMargin.side)?.data).toBe(url)
    // 同梱の読み取り器は余白が無くても読めた (画像の縁が境目になる)。
    // ただし規格は4マスの余白を求めており、暗い机の上などでは読めない
    // 読み取り器がある。図には余白を入れる。
    expect(jsQR(without.data, without.side, without.side)?.data).toBe(url)
  })
})
