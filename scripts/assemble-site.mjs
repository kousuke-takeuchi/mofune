// 公開物 site/ を組み立てる。
//   site/        ← public-site/ の中身(紹介ページ。今はプレースホルダ)
//   site/app/    ← vite build の出力(PWA 本体)
//
// PWA を /app/ に置くのは設計書 §13 のサイト構成に合わせるため。あとから
// 配置を変えると Service Worker の scope とホーム画面に追加済みのアイコンが
// 壊れるので、紹介ページが未完成でも最初からこの形にしておく。
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'public-site')
const target = resolve(root, 'site')

await mkdir(target, { recursive: true })

/*
 * 前回の成果物を先に片付ける。上書きするだけだと、public-site から消した
 * ファイルが site/ に残り、そのまま公開されてしまう (作業用に置いた下書きが
 * 出ていく事故になる)。app/ は vite build がこの直前に書いているので残す。
 */
for (const entry of await readdir(target)) {
  if (entry === 'app') continue
  await rm(resolve(target, entry), { recursive: true, force: true })
}

await cp(source, target, { recursive: true })

const entries = await readdir(target)
console.log(`assembled site/ with: ${entries.sort().join(', ')}`)
