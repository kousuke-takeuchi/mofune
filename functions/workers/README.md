# Mofune の通知用ワーカー (任意)

置かなくても Mofune は動きます。置くと、お知らせを出したときに参加者の端末へ
無内容の push が届き、アプリを開いてもらいやすくなります。

このワーカーが持つのは**購読名簿と VAPID 鍵だけ**です。お知らせの本文も、
それを開く鍵も通りません。漏れても、無内容の通知を送られる以上のことは起きません。

## 置きかた

1. `npm i -D wrangler`
2. `npx wrangler kv namespace create MOFUNE` → 出た id を `wrangler.toml` に書く
3. VAPID の鍵を作る (ブラウザの開発者ツールでも作れます)

   ```js
   const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
   const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
   console.log('public', b64(await crypto.subtle.exportKey('raw', pair.publicKey)))
   console.log('private', b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)))
   ```

4. 秘密を入れる

   ```bash
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   npx wrangler secret put TOKENS      # {"g_xxxx":"グループごとの合言葉"}
   ```

5. `npx wrangler deploy` して出た URL を、アプリのグループ設定に入れる

## 契約

| | |
|---|---|
| `GET /health` | 生きているか。VAPID 公開鍵も返す |
| `POST /subscriptions` | `{ group_id, registry }` 購読名簿をまるごと差し替える |
| `POST /notify` | `{ group_id, scope_id }` そのスコープの購読者へ無内容 push |

`/subscriptions` と `/notify` は `Authorization: Bearer <グループの合言葉>` が要ります。

push サービスが「もう無い」(404/410) と答えた購読は、その場で名簿から外します。
