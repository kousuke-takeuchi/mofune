# Mofune の通知用スクリプト (Google Apps Script 版)

Cloudflare のアカウントを作らず、**Google アカウントだけ**で通知を送りたいグループ向けです。
やることは Workers 版と同じで、置かなくても Mofune は全機能が動きます。

このスクリプトが持つのは**購読名簿と VAPID 鍵だけ**です。お知らせの本文も、
それを開く鍵も通りません。

## 置きかた

1. <https://script.google.com/> で新しいプロジェクトを作ります

2. ファイルを3つ用意します

   | プロジェクト内の名前 | 中身 |
   |---|---|
   | `logic.gs` | このフォルダの `logic.js` をそのまま貼る |
   | `Code.gs` | このフォルダの `Code.gs` をそのまま貼る |
   | `jsrsasign.gs` | <https://kjur.github.io/jsrsasign/> の `jsrsasign-all-min.js` を貼る |

   `jsrsasign` は ES256 の署名に使います。Apps Script は楕円曲線の署名を
   自前で持っていないため、これだけは外のライブラリに頼ります。

3. VAPID の鍵を作ります。ブラウザの開発者ツールで次を実行してください。

   ```js
   const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
   const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)))
   const url = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
   console.log('公開鍵:', url(b64(await crypto.subtle.exportKey('raw', pair.publicKey))))
   const pkcs8 = b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
   console.log('秘密鍵 (PEM):\n-----BEGIN PRIVATE KEY-----\n' + pkcs8.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----')
   ```

   公開鍵は base64url のまま、**秘密鍵は PEM のかたち**で控えます (jsrsasign が PEM を読むため)。

4. 「プロジェクトの設定 → スクリプト プロパティ」に4つ入れます

   | 名前 | 値 |
   |---|---|
   | `VAPID_PUBLIC_KEY` | 手順3の公開鍵 |
   | `VAPID_PRIVATE_KEY` | 手順3の PEM (改行ごと貼る) |
   | `VAPID_SUBJECT` | `mailto:あなたのアドレス` |
   | `TOKENS` | `{"g_xxxx":"グループごとの合言葉"}` |

   `g_xxxx` はグループ ID です。アプリの URL (`#/g/g_xxxx/...`) に出ています。

5. 「デプロイ → 新しいデプロイ → 種類: ウェブアプリ」で、
   **実行するユーザー: 自分**、**アクセスできるユーザー: 全員** にして
   デプロイします。初回は「このアプリは Google で確認されていません」と出ますが、
   自分で作ったスクリプトなので「詳細 → 安全ではないページに移動」で進めます。

6. 出てきた `https://script.google.com/macros/s/.../exec` を、アプリの
   「グループの設定」の**関数の URL**へ、`TOKENS` に書いた合言葉を**合言葉**へ入れて保存します。

## 契約

Workers 版と同じです。ただし Apps Script の web アプリは `/exec` 固定で
パスを持てず、独自ヘッダを付けると preflight が走って答えられません。
そこでアプリ側は次のように呼び分けます (`src/notify/push.ts`)。

| | Workers | Apps Script |
|---|---|---|
| 行き先 | `…/notify` | `…/exec?path=/notify` |
| 合言葉 | `Authorization: Bearer …` | 本文の `token` |
| 本文の型 | `application/json` | `text/plain;charset=utf-8` |

Apps Script は応答の状態コードも選べないため、断るときも 200 で
`{"error":"unauthorized"}` を返します。アプリ側は本文の `error` を見て失敗と判断します。

## 確かめかた

デプロイ URL に `?path=/health` を付けて開くと、`{"ok":true,"vapidPublicKey":"…"}`
が返ります。返らなければ、デプロイのアクセス設定かスクリプト プロパティを見直してください。

判断のところ (`logic.js`) はリポジトリのテストで検査しています
(`tests/functions/gas-logic.test.ts`)。貼り付けたあとに動かないときは、
まず `jsrsasign.gs` の貼り忘れと、秘密鍵が PEM かどうかを疑ってください。
