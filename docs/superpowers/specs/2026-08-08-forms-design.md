# 埋め込みフォームと集計 設計

**日付:** 2026-08-08
**対象:** デザイン 04(回答)/ 06(作成)/ 07(集計)
**状態:** 承認済み

## 決めた形

### フォームの定義はお知らせの中に入れる

`MessageContent` に `form?: FormDefinition` を足す。お知らせと同じスコープ鍵で
封緘されるので、**質問と選択肢はそのお知らせを読める人だけが見える**。
設計書 §7.3 の `forms/` は使わない。参照を1つ増やすと、フォームだけ届かない
中途半端な状態が作れてしまう。

```ts
interface FormDefinition {
  id: string                 // f_<hex>
  question: string
  choices: string[]          // 出欠は ['参加します', '欠席します'] を既定で入れる
  allowNote: boolean         // ひとこと欄を出すか
  dueAt: string | null
  /** 回答を開ける人。作成者だけ。 */
  recipient: { userId: string; ecdhPublic: string }
}
```

### 回答は作成者の鍵だけで開く

デザイン 04 の「回答は作成した担当者だけが読めます」を字義どおりに実装する。
回答は **staff スコープではなく、作成者の ECDH 公開鍵**へ封緘して inbox へ投函する
(`sealForRecipients([作成者])`)。担当者が複数いても、作成者以外は開けない。

```ts
interface FormResponse {
  kind: 'form-response'
  formId: string
  messageId: string
  userId: string
  displayName: string
  choice: string
  note: string
  at: string
}
```

送り方は不在連絡と同じ2経路。参加者は配られた投函枠、担当者・管理者は書き込み
資格情報で直接。

### 回収は作成者の端末だけで行う

`collectInbox` は開けなかった投函物を**消さずに数える**ので、作成者以外が受信箱を
処理しても回答は残る。`applyInbox` にも `form-response` を消さない分岐を足す。

集計画面は作成者の端末で回収し、`formResponses`(Dexie v4)へ入れてから投函物を
消す。**集計はその端末にしか無い。** 別の端末で開くとそこで回収した分しか見えない。
これは「作成者だけが読める」の裏返しであり、画面にそう書く。

## 画面

| 画面 | やること |
|---|---|
| 作成 (06) | 「フォームを入れる」で質問・選択肢・締切・ひとこと可否。出欠は選択肢の既定値 |
| 詳細 (04) | 選択肢を押して、ひとことを添えて送る。締切を過ぎたら送れない |
| 集計 (07) | `/g/:groupId/messages/:messageId/results`。作成者のみ。回答数・選択肢ごとの件数・一覧 |

## やらないこと

- 記述式のみのフォーム(ひとこと欄で足りる)
- 未回答者の催促(誰が未回答かは名簿と突き合わせれば出せるが、催促の送信は通知層の話)
- 集計の書き出し
- 回答の締切による自動ロック以上の制御(締切後の回答は画面で止めるだけ)
