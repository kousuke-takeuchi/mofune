# ルーティングとセッション復帰 設計

**日付:** 2026-08-08
**対象:** PWA 本体 (`/app/`)
**状態:** 承認済み

## 解く問題

リロードすると何もかも消える。原因は2つある。

1. **画面の位置が URL に無い。** `App.vue` が `composing` / `reporting` / `panelOpen` / `absenceListOpen` / `openMessageId` / `notifyMessageId` の6つの ref で出し分けている。URL は常に `/app/` で、戻るボタンはアプリを出る。画面が増えるたびにこの分岐が伸び、`composing` と `panelOpen` が同時に真のような、あってはならない組み合わせが構造上つくれてしまう。
2. **端末に記録した接続コードを誰も読み戻していない。** `rememberGroup` はログイン成功時に接続コードとログインIDを IndexedDB へ書いているが、読む側が無い。そのため再開のたびに、紙のコードを全部打ち直すことになる。

鍵とパスワードをメモリだけに置く方針は変えない。要件書 §5 の「秘密鍵・パスワードを IndexedDB / localStorage に保存してはならない」はそのまま守る。**リロード後にパスワードだけ訊く**のが到達点で、パスキーや端末パスコードによる再認証の省力化は別の設計として切り出す(本書の対象外)。

## 方針

- ルーティングは **vue-router**、状態は **Pinia**。
- 「いまどの画面か」はルータだけが持つ。ストアは「誰としてログインしているか」だけを持つ。両方が画面状態を持つと、矛盾した組み合わせがまた作れてしまう。
- 履歴は **hash mode** (`/app/#/g/xxx`)。GitHub Pages は SPA のフォールバックを持たないため、history mode では直接アクセスとリロードが 404 になる。サーバー設定に依存しない形を選ぶ。将来ホスティングを移しても壊れない。

## ルート表

| path | name | 画面 | meta |
|---|---|---|---|
| `/` | `home` | 描画せず分岐のみ | `public` |
| `/login` | `login` | 接続コード + ID + パスワード | `public` |
| `/unlock` | `unlock` | パスワードのみ | `public` |
| `/provision` | `provision` | 開設ウィザード | `public` |
| `/g/:groupId` | `timeline` | タイムライン | — |
| `/g/:groupId/messages/:messageId` | `message` | お知らせ詳細 | — |
| `/g/:groupId/messages/:messageId/notify` | `notify` | 通知の送信 | `staffOnly` |
| `/g/:groupId/compose` | `compose` | お知らせを作る | `staffOnly` |
| `/g/:groupId/absence` | `absence` | れんらく | — |
| `/g/:groupId/absences` | `absences` | 届いた連絡 | `staffOnly` |
| `/g/:groupId/panel` | `panel` | 受信と配布 | `staffOnly` |
| `/g/:groupId/setup` | `setup` | メールアドレスの登録 | — |

`groupId` は乱数 (`g_` + hex6) なので URL に出ても何のグループかは漏れない。`messageId` がブラウザ履歴に残るが、ID だけでは本文を復号できない。

未知のパスは `/` へ送る。

## ストア

### `useSessionStore`

いま解錠されているセッション1つ。**リロードで消える。**

```ts
state: { session: Session | null; storage: StorageProvider | null;
         adminPublicKey: Bytes; emailConfirmed: boolean }
getters: { isSignedIn; groupId; role }
actions: {
  signIn(code: ConnectionCode, loginId: string, password: string): Promise<void>
  unlock(groupId: string, password: string): Promise<void>   // registry から code と loginId を取る
  signOut(): void
}
```

`signIn` は `login()` を呼び、`HttpStorageProvider(code.root)` を作り、`rememberGroup` で端末に記録し、参加者ならメール登録済みかを判定する。いま `LoginView` と `App.vue` に散っている処理をここへ集める。`unlock` は registry から接続コードとログインIDを読んで `signIn` と同じ経路を通る。

### `useGroupsStore`

端末に記録済みのグループ一覧。`db/groups.ts` (`listGroups` / `getGroup` / `rememberGroup` / `forgetGroup`) を包むだけ。`/` の分岐と `/unlock` の材料になる。

## ガード

`router.beforeEach` に集約する。

```
to.meta.public              → 通す
セッション無し:
  groupId = to.params.groupId ?? 最後に使ったグループ
  registry にある           → /unlock?next=<to.fullPath>
  registry に無い           → /login?next=<to.fullPath>
セッション有り & to.params.groupId ≠ session.groupId
                            → /unlock?next=<to.fullPath>
to.meta.staffOnly & role === 'member'
                            → /g/:groupId (timeline)
role === 'member' & !emailConfirmed & name !== 'setup'
                            → /g/:groupId/setup
```

`/` の分岐:

```
最後に使ったグループがある → /unlock?next=/g/<groupId>
無い                      → /login
```

`next` は同一オリジンの相対パスのみ受け付ける。外部 URL が入っていたら無視して `/g/:groupId` へ送る。細工したリンクで別サイトへ飛ばされないようにするため。

## ページ層

既存の `src/ui/*.vue` 10本は **props と emit のまま変更しない**。`src/pages/` に1画面1つの薄いアダプタを置き、ストアから props を組み立て、emit を `router.push` に変換する。

```
src/pages/TimelinePage.vue
  <TimelineView :session :storage @open="id => router.push({ name: 'message', params: { messageId: id } })" />
```

分ける理由は2つ。既存の UI テスト10本が無傷で残ること。`ui/` がルータもストアも知らないままテストできること。

`App.vue` は `<RouterView />` だけになる。

対応表:

| ページ | 包むビュー | emit の行き先 |
|---|---|---|
| `LoginPage` | `LoginView` | 成功 → `next` か `timeline` |
| `UnlockPage` | (新規、パスワード欄のみ) | 成功 → `next` か `timeline` |
| `ProvisionPage` | `ProvisionWizardView` | done → `login`(接続コードを添える) / cancel → `login` |
| `TimelinePage` | `TimelineView` | open → `message` |
| `MessagePage` | `MessageDetailView` | back → `timeline` |
| `ComposePage` | `ComposeView` | posted → `notify` / cancel → `timeline` |
| `NotifyPage` | `NotifyView` | close → `timeline` |
| `AbsencePage` | `AbsenceView` | sent / cancel → `timeline` |
| `AbsenceListPage` | `AbsenceListView` | close → `timeline` |
| `PanelPage` | `StaffPanelView` | close → `timeline` |
| `SetupPage` | `SetupView` | done → `timeline` |

タイムラインからの導線(お知らせを作る・受信と配布・届いた連絡・れんらく)は、現在 `App.vue` にあるボタン群を `TimelinePage` へ移す。

## UnlockPage

`db/groups.ts` から取れるのは接続コード・グループ名・ログインID。画面にはグループ名とログインIDを出し、パスワード欄だけを訊く。

- 「別のグループに入る」リンクで `/login` へ
- 「この端末の記録を消す」で `forgetGroup` → `/login`
- パスワード誤りは既存の `LoginError` の文言をそのまま出す(アカウント不存在と誤りを区別しない)

## テスト

新規:

- `tests/router/guards.test.ts` — memory history でガードの全分岐。未ログイン→unlock、記録なし→login、別グループ→unlock、参加者が担当者ルート→timeline、メール未登録→setup、`next` への復帰、外部 URL の `next` を拒否
- `tests/stores/session.test.ts` — signIn / unlock / signOut と、リロード相当(ストア再生成)で未ログインに戻ること
- `tests/pages/UnlockPage.test.ts` — 記録から名前と ID を出し、パスワードだけで入れる
- `tests/pages/TimelinePage.test.ts` — 代表として emit → URL 遷移を1本

既存の `tests/ui/*.test.ts` 10本は変更しない。壊れないことが分離できている証拠になる。

Pinia のテストは `createPinia()` を各テストで作り直し、状態を持ち越さない。

## やらないこと

- パスキー / 端末パスコードによる再認証の省力化(別設計)
- 入力途中の下書き保存
- 複数グループの同時ログイン(URL は将来に備えた形にするが、セッションは1つ)
- 画面デザインの刷新(`docs/design/Mofune Mobile.dc.html` の適用は別作業)

## 影響

- `vue-router` と `pinia` が依存に加わる。gzip で十数 kB 増える見込み。ビルド後に実測して記録する
- URL が `/app/#/...` になる。Service Worker の scope は `/app/` のままで影響しない
- `LoginView` の `rememberGroup` 呼び出しはストアへ移す。`LoginView` 自体は props/emit を変えない
