# 共通業務APIの使い方

業務APIは `web/src/app/api/v1` 配下のRoute Handlerに実装します。共通処理は [`web/src/api`](../../web/src/api) にあります。応答形式・状態コード・再送の契約は [PoC API設計書の2・3節](../After_School_Project_PoC_API設計書_v0.1.md#2-共通http契約) を参照してください。

## Route Handlerと入力

`defineApiRoute` に許可する `GET`、`POST`、`PATCH` の処理を渡し、Next.jsがRoute Handlerでサポートする7メソッドを次の形式でエクスポートします。業務処理は `{ data, status?, page? }` を返し、想定内の失敗は `ApiError` を送出します。[Next.jsのRoute Handler](https://nextjs.org/docs/app/api-reference/file-conventions/route#http-methods)

```ts
import { defineApiRoute } from "@/api/route";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineApiRoute({
  GET: () => ({ data: { ok: true } }),
});
```

- `parsePathParams` にNext.jsのデコード済みパス変数とIDのスキーマを渡します。クエリーは `parseQuery` で検証します。
- 更新のOrigin、Content-Type、再送キーはRoute Handlerの共通処理が確認します。本文は `readJson` で読み、入れ子の各オブジェクトに `z.strictObject` を使います。DB保存と再送照合には、検証・正規化した値を渡します。`isoDateTime` はISO 8601の入力をUTCへ正規化します。
- 一覧は `parseListQuery` で絞り込みを検証し、認証済み利用者、一覧の識別子、正規化済み条件、並び順を `createCursorCodec` に渡します。署名には環境ごとの `BETTER_AUTH_SECRET` を使用します。毎ページで現在の認可を適用し、同じ絞り込みと認可条件で件数を数えます。`limit + 1` 件まで読み込み、`listPage` で次ページの情報を生成します。

## 更新と再送

1. セッションから得た操作者ID、Route Handlerが渡した更新情報、検証済みJSONを `commitMutation(db, …)` へ渡します。
2. `resolveUserIds` で今回の操作に必要な利用者IDを列挙します。操作者を含む利用者行のロック取得後、`authorizeEntry` で最新の入口資格を確認します。対象の存在・状態・権限は、ロック取得後の `execute` または `authorizeReplay` で判定します。
3. `targets` で対象行を列挙します。ロック順は本体、申請、案件の順で、各分類ではテーブル名とIDの昇順です。確定済みの再送なら `authorizeReplay` で保存結果に対する現在の権限と閲覧期限を確認します。
4. 新しい操作は `execute` 内で対象への操作権限を確認し、`assertExpectedVersion` で版番号を比較します。権限判定に必要な利用者が追加で判明したら `requireLockedUsers` を呼び、ロックの取得をやり直します。期限判定、更新、通知・履歴・監査にはロック取得後のDB時刻 `now` と同じ `tx` を使います。
5. `commitMutation` は業務変更と確定済み操作記録を同時に保存します。戻り値はRoute Handlerからそのまま返せます。通報受付のような専用形式では、`data` を設計書の公開DTOに変換します。

## 環境設定

`BETTER_AUTH_URL` にはブラウザーからアクセスする正規のOriginを設定します。HTTPSを使い、開発・テストのループバックのみHTTPを許可します。Better AuthのHTTP入口を実装するときは [web-config.ts](../../web/src/auth/web-config.ts) の `authWebOptions()` を既存の `authOptions()` と組み合わせ、同じOriginとセッションCookie属性を適用します。

操作記録はPoCの利用期間中保持します。
