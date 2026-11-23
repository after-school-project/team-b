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

- `Allow` には対象ルートで定義した業務メソッドが入ります。Next.jsが対応する7メソッドが業務APIの405の適用範囲です。`HEAD` のHTTP応答には本文が付きません。
- `parsePathParams` にNext.jsのデコード済みパス変数とIDのスキーマを渡します。クエリーは `parseQuery` で検証します。
- 更新のOrigin、Content-Type、再送キーはRoute Handlerの共通処理が確認します。確認の順序は[ログイン後の業務API](#ログイン後の業務api)を参照してください。本文は `readJson` で読み、入れ子の各オブジェクトに `z.strictObject` を使います。DB保存と再送照合には、検証・正規化した値を渡します。`isoDateTime` はISO 8601の入力をUTCへ正規化します。
- タイトルと本文には `title`・`longText`・`shortText` を使います。NUL（U+0000）や単独のUTF-16サロゲートを含む値には、該当フィールドを示す422を返します。
- 一覧は `parseListQuery` で絞り込みを検証し、認証済み利用者、一覧の識別子、正規化済み条件、並び順を `createCursorCodec` に渡します。署名には環境ごとの `BETTER_AUTH_SECRET` を使用します。毎ページで現在の認可を適用し、同じ絞り込みと認可条件で件数を数えます。`limit + 1` 件まで読み込み、`listPage` で次ページの情報を生成します。

## ログイン後の業務API

ログイン後に使う業務API（停止中は利用できないもの）は、`defineApiRoute` ではなく [`defineAuthorizedApiRoute`](../../web/src/api/authorized-route.ts) で定義します。各処理の前に [共通認可サービス](../../web/src/auth/access.ts) でセッション、発行・学校確認、停止を判定し、処理にはDBから読んだ最新の `Viewer` を渡します。操作者ID・所属・権限はリクエストの値から受け取らず、`viewer` を使います。[共通認可条件表](../After_School_Project_PoC_共通認可条件表_v0.1.md)

```ts
import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { commitMutation } from "@/api/mutation";
import { readJson } from "@/api/request";
import { authorizeActiveEntry } from "@/auth/access";
import { db } from "@/db/client";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute({
  GET: (request, context, viewer) => ({ data: { userId: viewer.userId } }),
  async POST(request, context, viewer, input) {
    const body = await readJson(request, schema);
    return commitMutation(db, {
      actorId: viewer.userId,
      request: input,
      body,
      authorizeEntry: authorizeActiveEntry(viewer.userId),
      authorizeReplay: async (context, original) => { /* 保存結果に対する現在の権限を確認する */ },
      execute: async ({ tx, now }) => { /* 対象への権限確認、版番号の比較、更新 */ },
    });
  },
});
```

- `GET` の処理は `(request, context, viewer)`、`POST`・`PATCH` の処理は `(request, context, viewer, input)` を受け取ります。`input` は `defineApiRoute` の更新情報と同じです。
- 判定結果に応じて、次の応答を返します。いずれの場合も業務処理は呼ばれず、停止理由や業務データは返しません。

  | 状態 | 応答 |
  |---|---|
  | セッションがない・失効・不正 | 401 `AUTH_REQUIRED` |
  | 発行・学校確認が未完了 | 403 `ACCOUNT_NOT_READY` |
  | 停止中 | 403 `ACCOUNT_SUSPENDED` |

- 更新は、Origin、利用資格、形式（Content-Type・`Idempotency-Key`・クエリー・パス）の順に確認します。他サイトからの更新は、セッションの有無より先に403 `ORIGIN_NOT_ALLOWED` で拒否します。未認証・利用資格なしの更新は、形式の誤りより先に401・403で拒否します。`defineApiRoute` は利用資格を判定せず、Originの後に形式を確認します。
- プロフィール状態・所属・管理権限・所有者・対象状態による制限は、渡された `viewer` と対象の最新状態で各処理が判定します。
- `defineApiRoute` を直接使うのは、利用資格によらず応答を返す必要があるAPIだけです。たとえば利用状態取得（`GET /api/v1/me`）は、停止中も本人向けの案内を200で返すため `defineApiRoute` を使います。

## 管理エリアの業務API

管理エリアのAPI（`/api/v1/admin/*`）は [`defineAdminApiRoute`](../../web/src/api/admin-route.ts) で定義し、必要な管理権限の区分を最初の引数に渡します。上の共通認可の後に [管理権限の共通判定](../../web/src/auth/admin.ts) を行い、権限が足りなければ処理を呼ばずに403 `FORBIDDEN` を返します。一般の業務API（`defineAuthorizedApiRoute`）は管理権限の有無に関係なく利用でき、アプリ管理者の権限を解除しても一般利用者としてのログインは続きます。

| 区分 | 利用できる管理者 | 例（共通認可条件表 §4） |
|---|---|---|
| `"any"` | 学校管理者、または停止・プロフィール非表示・権限解除の制限がないアプリ管理者 | 申請の審査、ユーザー一覧、通報案件の取得 |
| `"school"` | 学校管理者のみ | 本人確認情報、削除済み証拠、操作ログ、卒業区分、アプリ管理者の付与・解除、引継ぎ待ち |

更新では `commitMutation` の `authorizeEntry` に `authorizeAdminEntry(viewer.userId, 区分)` を渡します。実行者の行をロックした後に最新状態で実行者の管理資格を再判定するため、権限解除・停止・プロフィール非表示と処理中の更新が直列化されます。

対象者によって学校専用になる操作（対象者がアプリ管理者の停止・プロフィール非表示、アプリ管理者が投稿したQ&Aの強制非表示など）は、入口と `authorizeEntry` を `"any"` で通し、`resolveUserIds` に対象者を含めます。対象者による区分は、`execute` と `authorizeReplay` の中で `requireAdminForLockedTarget` を使って判定します（対象者がアプリ管理者なら学校管理者のみ、対象者がいなければ404）。対象者の行もロックした後に判定するため、対象者のアプリ管理者化と処理中の更新も直列化されます。

`authorizeEntry` で対象者を参照しないのは、判定の順序を共通認可条件表のとおりに保つためです。実行者自身の資格不足は対象者の有無にかかわらず同じ403で拒否し、同じ再送キーを別の内容に使った場合は、対象者の判定より先に409 `IDEMPOTENCY_KEY_REUSED` を返します。

```ts
import { defineAdminApiRoute } from "@/api/admin-route";
import { authorizeAdminEntry, requireAdminForLockedTarget } from "@/auth/admin";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute("any", {
  async POST(request, context, viewer, input) {
    const { userId } = parsePathParams(await context.params, { userId: userIdSchema });
    return commitMutation(db, {
      actorId: viewer.userId,
      request: input,
      body,
      resolveUserIds: async () => [userId],
      // 行ロック後に実行者自身の管理資格だけを再判定する（対象者は参照しない）。
      authorizeEntry: authorizeAdminEntry(viewer.userId, "any"),
      async authorizeReplay(context, original) {
        // 再送時も、対象者の現在の管理権限で判定する。
        await requireAdminForLockedTarget(context, viewer.userId, userId);
      },
      async execute(context) {
        // 対象者がアプリ管理者なら学校管理者のみ。対象者がいなければ404。
        const target = await requireAdminForLockedTarget(context, viewer.userId, userId);
        /* 学校管理者を対象にできない等の操作ごとの条件（target.schoolManager など）、更新 */
      },
    });
  },
});
```

- 区分を満たさない場合は403 `FORBIDDEN` を返し、どの権限が足りないかは返しません。停止中・未完了は管理権限より先に、一般の業務APIと同じ403で拒否します。
- 自己審査の禁止、学校管理者を対象にできない操作、通報案件の学校専用属性など、操作ごとの条件は各機能の処理で判定します。

## 所有者・公開範囲による取得制御

本人用データ・公開範囲・対象状態による制限は、取得したデータから後で取り除くのではなく、取得条件と返却項目の段階で適用します。[共通認可条件表](../After_School_Project_PoC_共通認可条件表_v0.1.md) §1〜§3

| 用途 | 共通処理 | 使い方 |
|---|---|---|
| 本人用の一覧・取得 | [`ownedBy`](../../web/src/auth/ownership.ts) | 所有者列を `viewer.userId` で絞る条件。他人の行は結果・件数・カーソルに含まれず、ID指定の取得では存在しない対象と同じ404になる |
| 取得後の本人確認 | `requireOwned` | 申請の所有者を親の投稿者で判定する場合など、取得条件に所有者を含められないときに使う。対象がない場合も他人の場合も同じ404 `NOT_FOUND` |
| 本人かどうか | `isOwner` | セッションの利用者IDとDBの所有者IDが一致するか。リクエストの所有者ID・actorId は使わない |
| 一般の閲覧者向けの公開条件 | [`visibleQuestion`・`visibleResponse`・`publishedNotice`・`publishedEvent`](../../web/src/auth/visibility.ts) | 強制非表示・削除済み・公開版のないものを除く条件。お知らせ・イベントの本文は `publicRevisionId` の版から取得し、審査中の版を返さない |
| 削除済みお知らせの本文 | `retainedDeletedNotice` | 削除から180日の期間内の条件。本人・学校管理者の判定と組み合わせる。更新では `commitMutation` の `now` を渡す |
| プロフィール | `publicProfileState`・`projectOptionalProfileFields` | 公開中のプロフィールの条件と、任意項目の返却範囲。本人には全項目、本人以外には `members` の項目だけを返し、本人のみの項目はキーごと省略する |
| 一覧・件数・カーソル | [`queryListPage`](../../web/src/api/pagination.ts) | `authorized`（認可条件）と `filters`（検索条件）を件数と各ページの両方に適用し、返した行からだけ次ページのカーソルを作る |

```ts
import { createCursorCodec, parseListQuery, queryListPage } from "@/api/pagination";
import { visibleQuestion } from "@/auth/visibility";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute({
  async GET(request, context, viewer) {
    const { limit, cursor, q } = parseListQuery(new URL(request.url), { q: z.string().optional() });
    const codec = createCursorCodec({ actorId: viewer.userId, list: "questions", filters: { q }, sort: "createdAt:desc,id:desc" }, position);
    const last = codec.decode(cursor);
    return queryListPage({
      authorized: visibleQuestion(),
      filters: q ? ilike(qaQuestions.title, `%${q}%`) : undefined,
      after: last ? sql`(${qaQuestions.createdAt}, ${qaQuestions.id}) < (${last[0]}::timestamptz, ${last[1]}::uuid)` : undefined,
      limit,
      rows: (where, take) => db.select(/* 返却項目だけ */).from(qaQuestions).where(where).orderBy(/* 並び順 */).limit(take),
      count: async (where) => (await db.select({ n: count() }).from(qaQuestions).where(where))[0].n,
      cursorFor: (row) => codec.encode([row.createdAt.toISOString(), row.id]),
    });
  },
});
```

- 返却項目は、DTO に入れる列だけを選びます。非公開値をブラウザーへ送って表示だけを隠す実装はしません。
- 公開条件は一般の閲覧者向けです。本人・管理者向けの取得、親質問が削除された回答の扱い、所属による投稿可否など、機能ごとの条件は各機能でこれらと組み合わせて判定します。
- 本人用の一覧・申請・通知を他人が要求した場合は、存在の有無を明かさない404にします。存在するスレッドの状態案内として本文なしで返せるQ&Aなど、許可された投影は各機能のDTOに従います。

## 更新と再送

1. `viewer.userId`（セッションから得た操作者ID）、Route Handlerが渡した更新情報、検証済みJSONを `commitMutation(db, …)` へ渡します。
2. `resolveUserIds` で今回の操作に必要な利用者IDを列挙します。操作者を含む利用者行のロック取得後、`authorizeEntry` で最新の入口資格を確認します。ログイン後の業務APIでは `authorizeActiveEntry(viewer.userId)` を渡し、Route Handlerの入口での判定後に停止された場合も行ロック後に拒否します。プロフィール非表示中の新規投稿・既存編集を拒否する操作では `authorizeActiveEntry(viewer.userId, { profileWritable: true })` を渡します。対象の存在・状態・権限は、ロック取得後の `execute` または `authorizeReplay` で判定します。
3. `targets` で対象行を列挙します。ロック順は本体、申請、案件の順で、各分類ではテーブル名とIDの昇順です。確定済みの再送なら `authorizeReplay` で保存結果に対する現在の権限と閲覧期限を確認します。
4. 新しい操作は `execute` 内で対象への操作権限を確認し、`assertExpectedVersion` で版番号を比較します。権限判定に必要な利用者が追加で判明したら `requireLockedUsers` を呼び、ロックの取得をやり直します。期限判定、更新、通知・履歴・監査にはロック取得後のDB時刻 `now` と同じ `tx` を使います。
5. `commitMutation` は業務変更と確定済み操作記録を同時に保存します。戻り値はRoute Handlerからそのまま返せます。通報受付のような専用形式では、`data` を設計書の公開DTOに変換します。

## 環境設定

`BETTER_AUTH_URL` にはブラウザーからアクセスする正規のOriginを設定します。HTTPSを使い、開発・テストのループバックのみHTTPを許可します。Better AuthのHTTP入口を実装するときは [web-config.ts](../../web/src/auth/web-config.ts) の `authWebOptions()` を既存の `authOptions()` と組み合わせ、同じOriginとセッションCookie属性を適用します。

操作記録はPoCの利用期間中保持します。
