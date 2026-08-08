import jsQR from 'jsqr'

/**
 * カメラの1コマから QR の中身を取り出す。
 *
 * `BarcodeDetector` を持つブラウザ (Android の Chrome など) は速いが、
 * iOS の Safari には無い。iPhone を外すわけにはいかないので、読み取り器
 * (jsqr) を**同梱**する。外部 CDN は使わない方針なので、npm から入れて
 * まとめてビルドに載せる。
 *
 * 1コマを canvas へ写して画素を渡す。video から直に読める API は無い。
 */
export function readQrFromFrame(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
): string | null {
  const width = video.videoWidth
  const height = video.videoHeight
  if (width === 0 || height === 0) return null

  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(video, 0, 0, width, height)

  const frame = context.getImageData(0, 0, width, height)
  const found = jsQR(frame.data, frame.width, frame.height, {
    // 反転した紙 (白地に黒/黒地に白) の両方を試す
    inversionAttempts: 'attemptBoth',
  })
  return found?.data ?? null
}
