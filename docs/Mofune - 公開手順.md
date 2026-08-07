# Mofune 公開手順 (GitHub Pages + mofune.site)

最終更新: 2026-08-07

配信先は GitHub Pages、ドメインは `mofune.site`(apex)と `www.mofune.site`。
公開は `master` への push で GitHub Actions が自動実行する。

## 1. サイト構成

設計書 §13 のサイト構成に合わせる。

| パス | 中身 | 現状 |
|---|---|---|
| `/` | 紹介トップページ | プレースホルダ (`public-site/index.html`) |
| `/privacy` | プライバシーポリシー | 未作成 (Phase 2d) |
| `/guide` | 導入手順書 | 未作成 (Phase 2d) |
| `/app/` | PWA 本体 | 稼働 |

**PWA を最初から `/app/` に置いているのは意図的である。** あとから配置を変えると
Service Worker の scope と、利用者がホーム画面に追加済みのアイコンが壊れる。
紹介ページが未完成でもこの形を崩さないこと。

`vite.config.ts` の `base: '/app/'` と `build.outDir: 'site/app'` がこれを担っている。

## 2. ビルドの仕組み

```bash
npm run build
```

1. `vue-tsc --noEmit` — 型チェック
2. `vite build` — PWA を `site/app/` へ出力(`base: /app/`)
3. `node scripts/assemble-site.mjs` — `public-site/` の中身を `site/` 直下へコピー

結果として公開物は次の形になる。`site/` は `.gitignore` 済み。

```
site/
├ index.html      ← 紹介ページ(プレースホルダ)
└ app/
  ├ index.html
  └ assets/…
```

ローカルで確認するには `npm run build` 後に `site/` を任意の静的サーバーで配信する。

## 3. GitHub 側の設定(初回のみ)

### 3.1 Actions からの公開を有効にする

1. リポジトリの **Settings → Pages** を開く
2. **Build and deployment → Source** を **GitHub Actions** にする
3. **Custom domain** に `mofune.site` を入力して Save

> カスタムワークフローから公開する場合、GitHub は `CNAME` ファイルを作らず、
> 既存の `CNAME` ファイルも無視する(公式ドキュメント記載)。このリポジトリに
> `CNAME` ファイルを置いていないのはそのため。ドメインは Settings 側が正本。

### 3.2 ワークフローに必要なトークンスコープ

`.github/workflows/` を含む push には `workflow` スコープが要る。gh CLI のトークンに
無い場合は次で足す。

```bash
gh auth refresh -h github.com -s workflow
```

## 4. DNS 設定

以下は GitHub 公式ドキュメント([Managing a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site))で確認した値。

### 4.1 apex ドメイン (`mofune.site`)

`A` レコード 4 本。ホスト名は `@`。

```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

IPv6 も設定する場合は `AAAA` レコード 4 本を追加する。

```
2606:50c0:8000::153
2606:50c0:8001::153
2606:50c0:8002::153
2606:50c0:8003::153
```

DNS プロバイダが `ALIAS` / `ANAME` に対応していれば、A/AAAA の代わりにそれ 1 本でもよい。

### 4.2 www サブドメイン (`www.mofune.site`)

`CNAME` レコード 1 本。

```
www  →  kousuke-takeuchi.github.io
```

apex と www の両方を設定すると、GitHub が自動でリダイレクトを張る。Settings の
Custom domain に `mofune.site` を入れてあるので、`www.mofune.site` → `mofune.site`
の向きになる。

**ワイルドカード(`*.mofune.site`)は設定しないこと。** ドメイン乗っ取りの危険があると
公式ドキュメントが警告している。

### 4.3 反映確認

```bash
dig mofune.site +noall +answer -t A
dig www.mofune.site +noall +answer -t CNAME
```

A レコードが上記4つと一致すればよい。

### 4.4 HTTPS

DNS が反映されると Settings → Pages に **Enforce HTTPS** が現れるので有効にする。
証明書の発行に最大24時間かかることがある。

要件書 §5.2 で実行時の外部CDN接続を禁じているため、フォント等を後から追加する際も
必ず同梱すること。CSP を張る場合もこの前提で書ける。

## 5. デプロイの流れ

`master` に push すると `.github/workflows/deploy.yml` が動く。

1. `npm ci`
2. `npm run typecheck`
3. `npm run test:run`
4. `npm run build`
5. `site/` を Pages へアップロードして公開

**型チェックとテストを通してからでないと公開されない。** 壊れたものが
`mofune.site` に出ないようにするための順序なので、速さのために外さないこと。

手動で流したいときは Actions タブから `workflow_dispatch` で実行できる。

## 6. まだ済んでいないこと

- Settings → Pages の Source を GitHub Actions にする(3.1)
- Custom domain に `mofune.site` を設定する(3.1)
- DNS レコードの登録(4)
- Enforce HTTPS の有効化(4.4)
- 紹介ページ・プライバシーポリシー・導入手順書の作成(Phase 2d)
- ドメイン検証(Settings → Pages → Verify domain)。乗っ取り対策として推奨
