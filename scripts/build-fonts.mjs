// 紹介サイトの同梱フォントを作る。
//
// 外部CDNからフォントを読むと、ページを見ただけで訪問者のIPが第三者に渡る。
// 「預けないから漏れません」と書いているサイトがそれをやるのは筋が通らないので、
// 必要な字だけを切り出した woff2 を自分で配る。
//
// 使う字はページの本文から数えるので、コピーを変えたら流し直すこと:
//   node scripts/build-fonts.mjs
//
// 必要なもの: python + fonttools + brotli (pip install fonttools brotli)
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const siteDir = resolve(root, 'public-site')
const outDir = resolve(siteDir, 'fonts')
const cacheDir = resolve(root, '.fontcache')

const RAW = 'https://raw.githubusercontent.com/google/fonts/main/ofl'

/** 元データ。いずれも SIL Open Font License 1.1。 */
const sources = [
  { name: 'ZenMaruGothic-Bold.ttf', url: `${RAW}/zenmarugothic/ZenMaruGothic-Bold.ttf` },
  { name: 'ZenMaruGothic-Black.ttf', url: `${RAW}/zenmarugothic/ZenMaruGothic-Black.ttf` },
  { name: 'NotoSansJP-var.ttf', url: `${RAW}/notosansjp/NotoSansJP%5Bwght%5D.ttf` },
  { name: 'OFL-ZenMaruGothic.txt', url: `${RAW}/zenmarugothic/OFL.txt` },
  { name: 'OFL-NotoSansJP.txt', url: `${RAW}/notosansjp/OFL.txt` },
]

/** 切り出す字。ページ本文にある字 + 記号・英数の下地。 */
const BASELINE =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`' +
  'abcdefghijklmnopqrstuvwxyz{|}~' +
  '、。・「」『』()〜ー…—–‐’“”※→←↑↓±·§©'

async function download(entry) {
  const path = resolve(cacheDir, entry.name)
  if (existsSync(path)) return path
  const response = await fetch(entry.url)
  if (!response.ok) {
    throw new Error(`${entry.url} returned ${response.status}`)
  }
  await writeFile(path, Buffer.from(await response.arrayBuffer()))
  return path
}

/** ページから、実際に使われている字を集める。 */
async function collectCharacters() {
  const names = (await readdir(siteDir)).filter((name) => name.endsWith('.html'))
  let text = BASELINE
  for (const name of names) {
    const html = await readFile(resolve(siteDir, name), 'utf8')
    text += html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
  }
  return [...new Set([...text])].filter((ch) => ch.trim() !== '').sort().join('')
}

// Windows の python は shim (.bat) のことがあり、shell を通さないと起動できない。
function python(args) {
  execFileSync(
    process.env.PYTHON ?? 'python',
    // shell を通すぶん、空白を含むパスが割れないよう自分で括る
    args.map((arg) => (/[\s]/.test(arg) ? `"${arg}"` : arg)),
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
}

function subset(input, output, textFile) {
  python([
    '-m',
    'fontTools.subset',
    input,
    `--text-file=${textFile}`,
    '--flavor=woff2',
    '--layout-features=kern,liga,palt,vert,vrt2',
    '--no-hinting',
    '--desubroutinize',
    `--output-file=${output}`,
  ])
}

await mkdir(cacheDir, { recursive: true })
await mkdir(outDir, { recursive: true })

const paths = {}
for (const entry of sources) {
  paths[entry.name] = await download(entry)
}

const characters = await collectCharacters()
const textFile = resolve(cacheDir, 'characters.txt')
await writeFile(textFile, characters, 'utf8')
console.log(`characters in use: ${[...characters].length}`)

// Noto Sans JP は可変フォントなので、使う太さに固定してから切り出す。
// 可変のまま配ると、使わない太さのぶんまで持たせることになる。
for (const weight of [400, 700]) {
  const pinned = resolve(cacheDir, `NotoSansJP-${weight}.ttf`)
  python(['-m', 'fontTools.varLib.instancer', paths['NotoSansJP-var.ttf'], `wght=${weight}`, '-o', pinned])
  subset(pinned, resolve(outDir, `noto-sans-jp-${weight}.woff2`), textFile)
}

subset(paths['ZenMaruGothic-Bold.ttf'], resolve(outDir, 'zen-maru-gothic-700.woff2'), textFile)
subset(paths['ZenMaruGothic-Black.ttf'], resolve(outDir, 'zen-maru-gothic-900.woff2'), textFile)

await writeFile(
  resolve(outDir, 'LICENSE.txt'),
  [
    'Zen Maru Gothic および Noto Sans JP は SIL Open Font License 1.1 で配布されています。',
    'ここに置いてあるのは、このサイトで使う字だけを切り出した派生物です。',
    '',
    '出典: https://github.com/google/fonts (ofl/zenmarugothic, ofl/notosansjp)',
    '再生成: node scripts/build-fonts.mjs',
    '',
    '--- Zen Maru Gothic ---',
    await readFile(paths['OFL-ZenMaruGothic.txt'], 'utf8'),
    '',
    '--- Noto Sans JP ---',
    await readFile(paths['OFL-NotoSansJP.txt'], 'utf8'),
  ].join('\n'),
  'utf8',
)

for (const name of await readdir(outDir)) {
  const info = await stat(resolve(outDir, name))
  console.log(`${name.padEnd(28)} ${(info.size / 1024).toFixed(1)} kB`)
}
