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

## Drive をグループの置き場にする (任意)

R2 のような S3 互換の置き場を用意せず、**この Apps Script が読み書きする Drive の
フォルダ**をグループの置き場にできます。Apps Script は所有者の権限で動くので、
参加者にも担当者にも OAuth も資格情報も渡りません。

1. Drive にグループ用のフォルダを1つ作り、URL の `folders/` に続く ID を控えます
2. スクリプト プロパティに `DRIVE_FOLDER_ID` としてその ID を入れます
3. アプリの接続コードの置き場所を、この `/exec` の URL にします

この経路の性質:

- **一覧が取れます**。公開バケットではできないので、`events-index.json` に頼らず
  差分同期ができます
- **読みは誰でもできます**。中身は封緘済みで、鍵を持つ人にしか開けません
- **書きはグループの合言葉**が要ります (担当者・管理者だけが持ちます)
- **参加者からの投函は引換券**で通します。担当者が「この置き場所へ1つ置いてよい」
  という短い符号 (合言葉と置き場所から作る HMAC) を配り、関数が同じ計算で確かめます。
  合言葉そのものは参加者へ渡りません

ファイルは `g_xxx/messages/m_1.enc` のような鍵の `/` を `__` に置き換えた名前で、
フォルダを掘らずに1階層に並べます。1件読むたびに階層をたどると遅くなるためです。

### 参加者からの連絡 (上り)

参加者は関数へ**引換券**を添えて投函します。券は「合言葉と置き場所から作った符号」で、
担当者がアプリを開いたときに配られます。合言葉そのものは参加者へ渡りません。
券は置き場所ごとに違うので、1枚を別の場所へ使い回すことはできません。

**向き不向き**: 写真を何枚も送るグループでは、Apps Script の実行時間と
1リクエストの大きさが先に効いてきます。添付が多い使い方をするなら R2 などの
S3 互換の置き場のほうが確実です。

## WebDAV (NAS) の上りだけを受ける

置き場は NAS のままで、**参加者からの連絡だけ**この関数に受けさせることもできます。
WebDAV には「参加者が1つだけ置ける URL」の仕組みが無いためです。

1. スクリプト プロパティに3つ入れます

   | 名前 | 値 |
   |---|---|
   | `WEBDAV_BASE_URL` | 書き込み用の WebDAV URL |
   | `WEBDAV_USERNAME` | 利用者名 |
   | `WEBDAV_PASSWORD` | パスワード |

2. 開設ウィザードの「WebDAV / NAS」で、**参加者からの連絡 (任意)** に
   この関数の URL と合言葉を入れます

`WEBDAV_BASE_URL` があるときは、`DRIVE_FOLDER_ID` ではなく WebDAV へ書きます。
お知らせの配信や閲覧はアプリが NAS を直に読み書きするので、関数を通りません。
関数が通るのは上りだけです。

NAS のパスワードは関数のなかだけにあり、参加者へは渡りません。参加者が持つのは
「この置き場所へ1つ置いてよい」という引換券だけです。
