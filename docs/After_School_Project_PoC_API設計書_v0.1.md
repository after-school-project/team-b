# After School Project PoC API設計書 v0.1

作成日 2026-11-12

## 1. 適用範囲・決定記録

本書はPoCの画面・操作を支えるHTTP APIの設計。根拠は[画面一覧](./After_School_Project_PoC_画面一覧設計書_v0.2.md)、[画面遷移・状態遷移](./After_School_Project_PoC_画面遷移・状態遷移設計書_v0.1.md)、[共通認可条件](./After_School_Project_PoC_共通認可条件表_v0.1.md)、[DB・ER設計](./After_School_Project_PoC_DB・ER設計書_v0.1.md)、[技術決定書](./After_School_Project_PoC_技術構成・認証方式決定書_v0.1.md)。機能要件IDは[MVP機能要件定義書](./After_School_Project_MVP機能要件定義書_v1.1.md)を参照する。

| 決定ID | 方針 | 根拠 |
|---|---|---|
| API-DEC-01 | 同じNext.jsアプリのRoute HandlersでJSON形式の業務APIを提供する。認証APIはBetter Auth SDKから利用する | 企画者からの適性・安全性の質問に対する推奨設計 |
| API-DEC-02 | タイトル100文字、質問・回答・お知らせ・イベント本文10,000文字、コメント・返信2,000文字を上限とする | 企画者回答 |
| API-DEC-03 | 対応済み通報案件は管理者による更新・再開を行わない。新たな通報は未終了案件へ統合し、なければ新しい案件を作る | 企画者回答 |
| API-DEC-04 | 卒業区分の誤変更は学校管理者が在校生／卒業生と卒業予定状態を指定して修正する | 企画者回答 |
| API-DEC-05 | 引継ぎ待ち案件の完了時は、完了操作をした学校管理者を担当者へ設定し、引継ぎ待ち解除と完了を同時に確定する | 企画者回答 |
| API-DEC-06 | URL、共通JSON形式、カーソルページング、版番号、再送キー、本文サイズと補助項目の上限を本書で定める | 実装契約を具体化する設計判断 |

HTTP APIを選ぶ理由は、URL・入力・返却値・認可条件を明示し、画面を介さずに受入確認できること。Server Actionsにもサーバー側での認証・認可が必要で、両方式の保護は実装と検証で成立させる。HTTP APIではCookie・Origin・入力検証・共通認可を各入口へ適用する。[Next.jsの認証・認可](https://nextjs.org/docs/app/guides/authentication)、[データセキュリティ](https://nextjs.org/docs/app/guides/data-security)

Server Componentからは同じ認可付きサーバーサービスを直接呼び出せる。ブラウザー向けAPIと内部呼び出しで、許可条件・入力検証・返却項目の制限を共有する。URLやDTOの定義は本書を実装契約とする。AD-14関連のAPIは、簡易監査ログ画面の補完設計案を実装する場合の契約。

## 2. 共通HTTP契約

| 項目 | 契約 |
|---|---|
| 業務APIの接頭辞 | `/api/v1`。本書の業務API一覧のパスにはこの接頭辞を付ける |
| 認証API | `/api/auth`配下。Better AuthのNext.jsハンドラーへ接続する |
| 接続・認証 | 同一Origin、HTTPS、Better AuthのHttpOnly・Secure・SameSite=Lax Cookie、DBセッション。8時間固定期限・Cookieキャッシュ無効 |
| リクエスト・レスポンス | JSONはUTF-8、`Content-Type: application/json`。プロパティ名はcamelCase。DBのsnake_caseとの変換はサーバー側で行う |
| キャッシュ | 個人・コミュニティの応答は `Cache-Control: private, no-store`。共有キャッシュへ認可結果を保存しない |
| 更新の保護 | POST・PATCHに許可したOriginとの完全一致確認とCSRF保護を適用する。JSON Content-Typeを確認し、不明・不一致のOriginを拒否。Originのワイルドカード許可を行わない |
| メソッド | GETは取得。本文更新はPATCH、作成・審査・削除確認等の業務操作はPOST。未定義のメソッドは405とAllowヘッダーで拒否 |
| 削除 | 本人の削除は `POST .../deletion` とし、版番号と最終確認フラグをJSON本文で受け付ける |
| 本文サイズ | 業務APIのJSON本文はUTF-8で128 KiBまで。超過は413 |
| ID | userIdはBetter Authの不透明な文字列（1〜128文字）。その他のアプリIDはUUID。パス値はURLエンコードし、NUL・制御文字・余分な階層を拒否 |
| 日時 | 入力はタイムゾーンオフセット付きISO 8601、返却はUTCの `Z` 付き文字列。日付だけ・タイムゾーンなしの開催日時は422。開催日の判定と翌日00:00算出はAsia/Tokyo |
| 未知の入力 | 未定義の本文フィールドは422、未定義のクエリーや値は400。クライアントからactorId・管理権限・所有者IDを指定して操作主体を変更できない |

更新のOrigin・Content-Type確認とCookieの設定を組み合わせ、サーバーで最新の認可と入力を確認する。Server Actionsの保護をRoute Handlersへ自動適用されるものとして扱わない。[Next.jsのRoute Handlers](https://nextjs.org/docs/app/getting-started/route-handlers)

PoCの業務更新では、許可Originとの完全一致・JSON限定・Cookie属性をCSRF対策の契約とし、別のCSRFトークン発行APIは設けない。許可Originは環境別の固定設定から取得し、要求のHost値だけで動的に信頼しない。クロスOrigin向けのCORS許可を公開せず、認証API自身の保護はBetter Auth側でも有効にする。ローカル開発のHTTP例外はローカル設定に限定する。

### 成功形式

単一の取得は `data` にDTO、一覧は `data.items` にDTO配列を返す。すべての業務応答にサーバー生成のrequestIdとserverTimeを付ける。

```json
{
  "data": { "items": [] },
  "meta": {
    "requestId": "7b19476f-4c67-4b49-84dc-fc0be40da952",
    "serverTime": "2026-11-12T03:00:00.000Z",
    "page": { "limit": 20, "hasMore": false, "nextCursor": null, "totalCount": 0 }
  }
}
```

更新は `MutationResult` を返し、画面は必要な詳細を再取得する。一覧に201と記載した新規作成・再申請・卒業変更は201、その他の業務更新は200。取り下げ・削除・既読更新でも200とJSONを返す。

| MutationResultのフィールド | 型・意味 |
|---|---|
| operationId | UUID。確定した操作の再送記録ID |
| resource | `{type, id}`。対象の種類とID。通報受付だけは4節・10節の受付専用応答を使用 |
| version | 確定後の対象の整数版番号。版を持たない既読操作・卒業変更バッチはnull |
| state | 確定した操作結果の状態コード。各領域の状態値を使用 |
| committedAt | 最初に確定したUTC日時 |
| affectedCount | 一括変更の確定人数。通常操作では省略 |

### エラー形式・HTTP状態

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "内容が更新されています。再読込して確認してください。",
    "fields": []
  },
  "meta": {
    "requestId": "7b19476f-4c67-4b49-84dc-fc0be40da952",
    "serverTime": "2026-11-12T03:00:00.000Z"
  }
}
```

| HTTP | codeの例 | 扱い |
|---|---|---|
| 400 | BAD_REQUEST、INVALID_CURSOR | JSON・クエリー・ID形式の不正。cursorの改ざん・条件不一致も含む |
| 401 | AUTH_REQUIRED | 未認証・失効セッション。画面はAU-01へ |
| 403 | FORBIDDEN、ACCOUNT_NOT_READY、ACCOUNT_SUSPENDED、PROFILE_WRITE_RESTRICTED、ORIGIN_NOT_ALLOWED | 共通・管理エリアの資格不足、停止、非表示中の変更制限、Origin不正 |
| 404 | NOT_FOUND | 対象なし、他人の本人用データ、閲覧できない対象。本文・実在の有無を明かさない |
| 409 | VERSION_CONFLICT、STATE_CONFLICT、IDEMPOTENCY_KEY_REUSED、CASE_CLOSED、ASSIGNEE_INELIGIBLE | 並行更新、処理済み申請、対応済み案件への更新、再送キーの別内容利用、担当不能等 |
| 413 | PAYLOAD_TOO_LARGE | 業務本文の128 KiB超過 |
| 415 | UNSUPPORTED_MEDIA_TYPE | JSON以外の更新本文 |
| 422 | VALIDATION_FAILED | 入力値・文字数・日時・必須条件違反。fieldsは `{path, code, message}` の配列 |
| 429 | RATE_LIMITED | 回数制限。再試行の秒数をRetry-Afterへ設定 |
| 500 | INTERNAL_ERROR | 想定外の失敗。DB・内部理由・秘密値を応答へ含めない |
| 503 | TEMPORARILY_UNAVAILABLE | DB停止、ロック待ち・再試行の上限到達。確定していない操作は同じ再送キーで再試行可 |

認可を満たさない対象に、その対象固有の版番号不一致や状態を返さない。認証 → 入口資格 → 対象の閲覧・操作権限を確認してから409等を判定する。ログイン失敗はIDの存在を区別しない画面表示に変換する。HTTP状態の意味はHTTP Semanticsに従い、業務上の版番号比較は409として定義する。[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)

## 3. 一覧・入力・競合・再送

### 一覧のクエリー

`List<T>` は2節の一覧成功形式。limitは既定20・最大50、cursorは次ページ用の不透明な値。totalCountは同じ検索条件・現在の認可で取得できる件数。権限外データを先に数えてから削除しない。

cursorは利用者・対象一覧・正規化した検索条件・並び順・最後の並び値とIDにひも付けて署名する。条件変更時はcursorを破棄する。毎ページで現在の認可を再判定する。並行更新で一覧の位置が変わる場合があるため、画面はIDで重複を除き、更新後に先頭から取得する。

| 一覧 | クエリーと既定値 |
|---|---|
| 卒業生検索 | q、department、entryYear、graduationYear。display_name昇順・userId昇順 |
| Q&A | q、category、resolution=all/open/resolved（既定all）。createdAt降順・ID降順 |
| Q&A回答・コメント | createdAt昇順・ID昇順。questionId内でページング |
| 本人Q&A | kind=all/question/answer/comment/reply（既定all）。createdAt降順・ID降順 |
| 一般お知らせ | q。初回公開日時降順・ID降順に固定 |
| 本人お知らせ | state=all/pending/public/rejected/withdrawn/deleted、sort=created_desc/updated_desc（既定created_desc）。qなし |
| 一般イベント | q、state=all/scheduled/ended/cancelled、sort=created_desc/starts_asc（既定created_desc） |
| 本人イベント | state=all/pending/rejected/withdrawn/scheduled/ended/cancelled（既定all）、sort=created_desc/starts_asc（既定created_desc）。qなし |
| お知らせ・イベント審査 | status=pending/approved/rejected/all（既定pending）、kind=all/new/edit（既定all）。pendingは元のsubmittedAt昇順・ID昇順、それ以外はsubmittedAt降順。qなし |
| プロフィール再公開審査 | status=pending/approved/rejected/all（既定pending）。pendingはsubmittedAt昇順、それ以外は降順 |
| 本人の申請履歴 | submittedAt降順・ID降順。本人の新規／編集申請を取り下げも含めて返す |
| 公開管理 | publicationState=all/public/hidden（お知らせはdeletedも可）。学校専用の取得を同じフィルターに適用。createdAt降順 |
| 通報案件 | status=unhandled/in_progress/closed/all（既定unhandled）、priority=unset/normal/high、assigneeId。updatedAt降順・ID降順 |
| 引継ぎ待ち | 学校専用。未終了かつhandoffPending=trueのみ、createdAt昇順・ID昇順 |
| 通知 | state=all/unread（既定all）。createdAt降順・ID降順 |
| 管理ユーザー | q、baseRole=student/alumni/staff、accountStatus=active/suspended、managerRole=school/app/none。省略した属性は絞らず、複数属性はAND。公開表示名・ユーザーIDで検索し、本人確認情報を検索候補へ混ぜない。displayName昇順・userId昇順 |
| 案件履歴・通報明細・証拠 | createdAtまたはcapturedAt昇順・ID昇順 |
| 卒業変更履歴・操作ログ | createdAt降順・ID降順。卒業履歴はuserId・batchIdで絞り込み可 |

イベント審査のstatus=allには取り下げ済み履歴も含める。お知らせの取り下げ済みはstatus=allでも管理者一覧・履歴から除外する。審査以外で同値の並びがある一覧にもIDの順序を付ける。卒業候補はdisplayName昇順・userId昇順、modeの既定はgraduateとする。

一般イベントのstateは既定all、本人お知らせのstateも既定all、公開管理のpublicationStateは既定all。通報案件のpriority・assigneeIdは省略時に絞り込まない。managerRole=noneは両管理権限なし。割当候補にはlimit・cursorだけを受け付け、公開名昇順・userId昇順とする。

qは前後空白を除いた1〜100文字。学科は100文字以内、年度は4桁整数。検索値はパラメーターとして扱う。qは対象の公開版・公開項目に対する部分一致で、私有項目や申請版に一致したかを結果・件数へ反映しない。各sortの同時刻・同値はIDで順序を確定する。

### 入力の共通型

| 型名 | 値・検証 |
|---|---|
| Title | 前後空白除去後1〜100文字。改行なしのプレーンテキスト |
| LongText | 空白のみを拒否、最大10,000文字。質問・回答は制限Markdown、お知らせ・イベントはプレーンテキスト |
| ShortText | 空白のみを拒否、最大2,000文字。Q&Aコメント・返信の制限Markdown |
| Reason | 最大1,000文字。必須とする操作では空白のみを拒否。任意の場合は省略・nullを可とし、未入力はnullへ正規化 |
| ExpectedVersion | 1以上の整数。更新対象のGETが返したversionをexpectedVersionとして送る |
| Confirmed | 最終確認が必要な操作ではJSONの `true` を必須とする。権限・対象状態はフラグとは別に検証 |
| OptionalProfileField | valueは文字列、visibilityはmembers/self。PATCHでは省略したプロパティを保持する。bio最大1000、occupation最大100、interests最大200文字 |

文字数はUnicodeコードポイントで数え、本文の改行はLFへ正規化する。本文の前後空白を保存時に勝手に除去せず、空白だけかの検証を別に行う。URLはHTTP／HTTPSだけを受け付ける。Markdownの許可構文は画面遷移設計書の初期入力契約に従う。

displayNameは前後空白除去後1〜50文字、改行なし。booleanを文字列から変換しない。クエリーのlimit・年度は10進整数表現だけを受け付け、limitは1〜50。プロフィール年度・学科の未設定はnull。任意プロフィール項目の値は空文字列を許可する。

### 版番号

更新APIは表に示すexpectedVersionを必須とする。プロフィールはprofiles.version、利用者管理・卒業変更はcommunity_users.version、質問・回答・公開管理は各本体version、審査・申請修正は各申請version、案件はreport_cases.versionを使う。通知の既読には版番号を要求せず、readAtがnullの場合だけ更新する。

イベント編集申請の修正は、申請ID・受付日時を維持して不変の新しい内容版へ差し替え、申請versionを増やす。審査は管理者が表示したversionと一致する場合だけ確定する。ロック順序・DB時刻・通知と監査の同時確定は共通認可条件表5節に従う。

### 再送キー

すべての業務POST・PATCHに `Idempotency-Key` を必須とする。8〜128文字の英数字・ハイフン・アンダースコアを受け付け、画面は操作ごとにUUIDを生成する。Better Authの認証APIはSDKの契約を使用する。

1. 認証と現在の入口資格を確認する。
2. actorIdとキーの組で、HTTPメソッド・正規化したパス・検証後本文のハッシュを照合する。同じキーの別内容・別操作は409。
3. 未処理なら、版番号・対象状態を再確認し、業務変更・履歴・通知・監査・operation_receiptsを同じトランザクションで確定する。
4. 同じ内容の確定済み操作なら、現在の対象閲覧権限を確認して同じMutationResultを返す。申請確定済み・削除済みといった、その操作自体が確定させた状態を再実行しない。meta.replayed=trueを付け、HTTP状態も最初と同じにする。
5. 管理権限喪失や保存期限到来で結果を取得できない場合は403または404とし、古い成功応答を無条件に再表示しない。確定済み操作の結果だけを返し、追加の通知・監査を発生させない。

再送記録はPoC環境の利用期間中保持する。応答を失った画面はキーと本文を保持して再試行し、入力を変えた場合は新しいキーを使用する。

## 4. 認証・利用状態

認証の3経路は `/api/auth` 配下、業務APIは `/api/v1` 配下。認証はNext.jsのcatch-allハンドラーに接続し、SDKのCookie処理と戻り値を使用する。[Better AuthのNext.js連携](https://better-auth.com/docs/integrations/next)、[username](https://better-auth.com/docs/plugins/username)

| API ID | メソッド・絶対パス | 入力・戻り値 | 認可・画面 |
|---|---|---|---|
| API-AUTH-01 | POST `/api/auth/sign-in/username` | SDKのusername・password。成功時に認証Cookie、SDKのセッション結果 | AU-01。未発行・パスワード不一致の画面表示を統一 |
| API-AUTH-02 | GET `/api/auth/get-session` | SDKのSessionまたはnull。業務APIの成功・エラー形式へ変換しない | AU-01。アプリの利用資格は続けてAPI-COM-01で確認 |
| API-AUTH-03 | POST `/api/auth/sign-out` | SDKのログアウト結果とCookie失効 | 停止中も呼出可能 |
| API-COM-01 | GET `/me` | `MeState` | 認証済み本人。停止案内に必要な最小情報を取得 |
| API-COM-02 | GET `/home` | `Home` | 非停止の利用資格確認済み利用者。GE-01 |

`MeState`は次のいずれか。発行未完了・学校確認未完了は403 ACCOUNT_NOT_READY、セッションなしは401。

| variant | dataのフィールド |
|---|---|
| active | access="active"、userId、baseRole、isGraduating、profileState、userVersion、roles={schoolManager, appManager}、capabilities={canEnterAdmin, canWriteContent}、sessionExpiresAt |
| suspended | access="suspended"、publicReasonのみ。内部理由・プロフィール・管理メニューを返さない |

停止中に200で取得できる業務APIはこの本人向け状態案内だけ。その他の業務APIは403 ACCOUNT_SUSPENDED。認証SDKの内部メール欄・nameをそのまま公開プロフィールへ転用しない。登録・メールログイン・ユーザー更新・退会・メール確認・回復・MFA・汎用管理プラグインの公開経路はPoCの許可ルートに含めない。採用版でSDKが使用する経路を照合し、未許可経路を直接呼んでも学校発行や審査を迂回できないことを確認する。

## 5. 共通DTO

以下のDTOはdataに入る値。表にあるフィールドを返却の許可リストとし、DBレコード全体を返さない。nullableのフィールドはnull、それ以外の非公開・対象外フィールドは省略する。

| DTO | フィールド・投影条件 |
|---|---|
| PublicAuthor | userId、displayName。投稿上の公開著者名だけを返し、非表示プロフィールの任意項目を補完しない |
| CapabilitySet | 操作に応じたcanEdit、canDelete、canRespond、canResolve、canWithdraw、canResubmit、canCancel、canReview、canHide、canRestore。各項目はboolean、対象外はfalse。実行時は再認可 |
| Category | code、name。コードはサーバーの初期投入値から選択 |
| ProfileFields | displayName、department、entryYear、graduationYear、optionalFields={bio,occupation,interests}。各任意値は `{value,visibility}`、本人には全値、他人にはmembersだけを返す |
| MyProfile | userId、version、profileState、baseRole、isGraduating、searchOptIn、fields:ProfileFields、review:ProfileReviewSummary/null。本人確認情報と管理権限の編集フィールドなし |
| PublicProfile | userId、state="public"、baseRole、isGraduating、fields:ProfileFields、capabilities={canReport}。本人のみの任意項目はキーごと省略 |
| HiddenProfile | userId、state="hidden"。氏名・所属・任意項目等のプロフィール情報を返さない |
| QuestionListItem | id、title、category:Category、author:PublicAuthor、resolution、responseCount、createdAt、updatedAt。一般一覧は未削除・公開中のみ |
| QuestionView | id、publicationState、content={title,bodyMarkdown,category}/null、author:PublicAuthor/null、resolution/null、version/null、createdAt/null、updatedAt/null、capabilities:CapabilitySet |
| ResponseView | id、questionId、parentResponseId/null、kind=answer/comment/reply、publicationState、content={bodyMarkdown}/null、author:PublicAuthor/null、version/null、createdAt/null、updatedAt/null、capabilities:CapabilitySet |
| MyQaItem | id、kind、questionId、questionTitle/null、questionState、excerpt/null、createdAt、targetPath。親質問削除時は質問本文を復元せず、残存する本人投稿の導線を返す |
| NoticeContent | title、body、categoryCode。bodyはプレーンテキスト |
| EventContent | title、description、startsAt、endsAt/null、format、venue/null、participationInfo/null、externalUrl/null |
| NoticeListItem | id、title、category:Category、originKind、author:PublicAuthor、firstPublishedAt、updatedAt。本文を含めない |
| EventListItem | id、title、startsAt、effectiveEndsAt、format、holdingState、originKind、createdAt。本文・参加方法の詳細は含めない |
| PublicNotice | id、content:NoticeContent、category:Category、originKind、author:PublicAuthor、firstPublishedAt、updatedAt。updatedAtは公開内容の更新時刻 |
| PublicEvent | id、content:EventContent、author:PublicAuthor、originKind、createdAt、updatedAt、effectiveEndsAt、holdingState、cancellationReason/null。開催状態は公開版から判定 |
| RequestSummary | id、resourceId、kind=new/edit、status、submittedAt、decidedAt/null、version、needsDateCorrection。本文・本人確認情報を含めない |
| ReviewRequest | RequestSummaryの全フィールド、content:NoticeContent/EventContent、applicant:PublicAuthor、decisionReason/null、withdrawalReason/null、capabilities:CapabilitySet。お知らせ編集審査には変更後本文のみ |
| ManagedContent | id、version、originKind、author:PublicAuthor、publicationState、publicContent:null/NoticeContent/EventContent、pendingRequest:RequestSummary/null、deletedContent:null/NoticeContent、deletedAt/null、retentionExpiresAt/null、holdingState/null、capabilities:CapabilitySet |
| ManagedNoticeListItem | id、version、title、categoryCode、originKind、publicationState、pendingRequest:RequestSummary/null、latestRequestStatus/null、deletedAt/null、retentionExpiresAt/null、createdAt、updatedAt、capabilities |
| ManagedEventListItem | id、version、title、startsAt、effectiveEndsAt、originKind、publicationState、holdingState/null、pendingRequest:RequestSummary/null、latestRequestStatus/null、createdAt、updatedAt、capabilities |
| ProfileReviewSummary | id、status=pending/approved/rejected、submittedAt、decidedAt/null、decisionReason/null、version |
| ProfileReview | ProfileReviewSummaryの全フィールド、userId、profileRevisionId、profileFields、capabilities。profileFieldsは公開予定の基本・members項目のみ。selfの任意項目を返さない |
| NotificationView | id、kind、message、createdAt、readAt/null、targetState。現在の対象権限がなければ汎用の状態案内だけを返す |
| NavigationTarget | state=available/withdrawn/deleted/hidden/expired/not_available、path:string/null。availableだけにサーバーで組み立てた同一アプリの相対パスを設定 |
| Home | questions:QuestionListItem[]、notices:NoticeListItem[]、events:EventListItem[]、notifications:NotificationView[]、unreadNotificationCount、navigation={canEnterAdmin}。各配列は最大5件、順序は画面遷移設計書に従う |

publicationStateは質問・回答でpublic/hidden/deleted、お知らせでunpublished/public/hidden/deleted、イベントでunpublished/public/hidden。holdingStateはscheduled/ended/cancelled。非公開の申請版をPublicNotice・PublicEventへ混入させない。

originKindはお知らせでschool/alumni、イベントでstaff/student/alumniとし、作成時に記録した区分を使う。RequestSummary.statusはpending/approved/rejected/withdrawn、needsDateCorrectionは新規イベントの要開催日修正だけtrue。その他はfalse。publicationStateとholdingState、申請statusは別属性であり、強制非表示の解除で申請・開催状態を変更しない。

削除済みQ&Aのcontent・author・version・日時・resolutionはnullとし、残存する子は各子の権限で取得する。強制非表示Q&Aのcontentは本人または当該対象を管理できる管理者だけに返し、それ以外はnull。親が削除・非表示でも、子を取得した応答へ親の本文をコピーしない。

非表示・削除のQ&Aは、存在するスレッドへの状態案内としてQuestionView／ResponseViewの本文なしの形で返せる。本人限定・学校専用の対象を取得する権限がない場合の404とは、許可される投影が異なる。Q&Aの一覧では非表示・削除した本体を列挙しない。

本人のManagedContentは自分の投稿だけ。管理者のManagedContentは対象区分別の管理権限を確認する。削除済みお知らせのdeletedContentは本人または学校管理者が180日未満だけ取得できる。期限後は本人・管理者の詳細と履歴取得を404とし、一般一覧に戻さない。

## 6. プロフィール・卒業生検索

以下のパスはすべて `/api/v1` 配下。

| API ID | メソッド・パス | 入力 | 成功data | 認可・関連画面 |
|---|---|---|---|---|
| API-PRO-01 | GET `/me/profile` | なし | MyProfile | 非停止の本人。非表示中も可。GE-02 |
| API-PRO-02 | PATCH `/me/profile` | ProfilePatch | MutationResult、state=public/hidden | 非停止の本人。非表示中の保存は再公開申請の作成／更新。GE-02 |
| API-PRO-03 | GET `/users/{userId}/profile` | userId | PublicProfileまたはHiddenProfile | 非停止の承認済み閲覧者。GE-03 |
| API-PRO-04 | GET `/alumni` | 一覧条件 | `List<PublicProfile>` | 掲載希望・公開中の卒業生／卒業予定者のみ。GE-04 |

ProfilePatchはexpectedVersion必須。displayName、searchOptIn、optionalFieldsのうち1つ以上を指定する。optionalFieldsはbio／occupation／interestsだけを受け付け、各項目でvalue・visibilityの指定したプロパティだけを置き換える。空文字列は値の消去、nullは422。省略項目は現在値を保持する。未設定の公開範囲はself。所属・学科・年度・本人確認情報は受け付けない。

```json
{
  "expectedVersion": 3,
  "displayName": "PoC卒業生A",
  "optionalFields": {
    "bio": { "value": "Web開発の相談に回答できます。", "visibility": "members" },
    "occupation": { "visibility": "self" }
  },
  "searchOptIn": true
}
```

保存ではprofiles.versionを比較し、不変版の作成・currentRevisionの更新・必要な再公開申請の更新を同時に確定する。審査中の再保存も新しい内容版を作り、review.versionを増やす。審査結果はMyProfile.reviewと本人通知から確認する。

## 7. Q&A

| API ID | メソッド・パス | 入力 | 成功data | 認可・関連画面 |
|---|---|---|---|---|
| API-QA-01 | GET `/question-categories` | なし | `{items:Category[]}`（4件、ページングなし） | 非停止の承認済み利用者。QA-01／QA-03 |
| API-QA-02 | GET `/questions` | 一覧条件 | `List<QuestionListItem>` | 公開中・未削除だけ検索。QA-01 |
| API-QA-03 | POST `/questions` | `{title,bodyMarkdown,categoryCode}` | 201 MutationResult、state=public | 全所属、プロフィール公開中。QA-03 |
| API-QA-04 | GET `/questions/{questionId}` | questionId | QuestionView | 削除済み親は本文なしの状態表示とし、残存回答への参照を維持。QA-02 |
| API-QA-05 | PATCH `/questions/{questionId}` | `{expectedVersion,title?,bodyMarkdown?,categoryCode?}` | MutationResult | 本人・プロフィール公開中・未削除。本文等を1つ以上指定。QA-03 |
| API-QA-06 | POST `/questions/{questionId}/deletion` | `{expectedVersion,confirmed:true}` | MutationResult、state=deleted | 本人。プロフィール非表示中も可。QA-02 |
| API-QA-07 | GET `/questions/{questionId}/responses` | 一覧条件 | `List<ResponseView>` | 同じ質問内の取得可能な回答・コメント・返信。QA-02 |
| API-QA-08 | POST `/questions/{questionId}/responses` | `{kind,parentResponseId?,bodyMarkdown}` | 201 MutationResult、state=public | 全所属、プロフィール公開中。QA-02 |
| API-QA-09 | GET `/responses/{responseId}` | responseId | ResponseView | 通知・本人一覧から選択した投稿や返信先を表示。QA-02 |
| API-QA-10 | PATCH `/responses/{responseId}` | `{expectedVersion,bodyMarkdown}` | MutationResult | 本人・プロフィール公開中・未削除。親・kindを変更しない。QA-02 |
| API-QA-11 | POST `/responses/{responseId}/deletion` | `{expectedVersion,confirmed:true}` | MutationResult、state=deleted | 本人。プロフィール非表示中も可。QA-02 |
| API-QA-12 | PATCH `/questions/{questionId}/resolution` | `{expectedVersion,resolution:"open"または"resolved"}` | MutationResult | 質問者本人・プロフィール公開中・未削除。QA-02 |
| API-QA-13 | GET `/me/qa-posts` | 一覧条件 | `List<MyQaItem>` | 本人投稿だけ。GE-05 |

categoryCodeはcareer（就職・キャリア）、learning（技術・学習）、projects（制作・プロジェクト）、chat（雑談）。API-QA-01の値と初期データを一致させる。

回答のkindはanswer、コメントはcomment、返信はreply。answerはparentResponseIdなし、replyは親レスポンス必須。commentの親は質問または同じ質問内のレスポンス。サーバーで親の所属質問と現在の取得・返信条件を確認する。answer本文はLongText、comment／replyはShortText。

回答一覧はフラットな配列としてparentResponseIdを返す。画面は親子関係を組み立て、未取得の返信先はAPI-QA-09で取得できる。通知の深い返信先も同APIから選択表示できる。解決状態を設定する操作はトグル値を送らず、設定する状態を送る。

削除は対象だけを論理削除し、子の回答・コメントを連鎖削除しない。削除済み質問への新しい回答・直接コメント、削除済みレスポンスへの直接返信は拒否する。残存レスポンスへの返信と本人編集・削除は各対象の条件で判定する。管理者非表示の親を表示する場合も制限された本文を返さず、残存する子は個別に判定する。

## 8. お知らせ

| API ID | メソッド・パス | 入力 | 成功data | 認可・関連画面 |
|---|---|---|---|---|
| API-NO-01 | GET `/notice-categories` | なし | `{items:Category[]}`、ページングなし | PoCの仮カテゴリーを返す。NO-03 |
| API-NO-02 | GET `/notices` | 一覧条件 | `List<NoticeListItem>` | 公開版だけ。NO-01 |
| API-NO-03 | POST `/notices` | NoticeContent | 201 MutationResult、state=public/pending | 職員は即時公開、卒業生は新規申請。在校生不可。NO-03 |
| API-NO-04 | GET `/notices/{noticeId}` | noticeId | PublicNotice | 非表示・削除・未公開は404。NO-02 |
| API-NO-05 | POST `/notices/{noticeId}/revisions` | `{expectedVersion,content:NoticeContent}` | MutationResult、state=public/hidden/pending | 本人・プロフィール公開中・公開済み・未削除・pendingなし。職員即時、卒業生再承認。NO-03 |
| API-NO-06 | GET `/me/notices` | 一覧条件 | `List<ManagedNoticeListItem>` | 本人だけ。削除済みは180日未満。NO-04 |
| API-NO-07 | GET `/me/notices/{noticeId}` | noticeId | ManagedContent | 本人だけ。強制非表示・期間内の削除済みも可。NO-04 |
| API-NO-08 | GET `/me/notices/{noticeId}/requests` | 一覧条件 | `List<RequestSummary>` | 本人の申請履歴。NO-05 |
| API-NO-09 | GET `/me/notice-requests/{requestId}` | requestId | ReviewRequest | 本人の申請本文・結果・理由。NO-05 |
| API-NO-10 | POST `/me/notice-requests/{requestId}/withdrawal` | `{expectedVersion}` | MutationResult、state=withdrawn | 本人・プロフィール公開中・pendingのみ。NO-05 |
| API-NO-11 | POST `/me/notice-requests/{requestId}/resubmission` | `{expectedVersion,content:NoticeContent}` | 201 MutationResult、state=pending | 本人・プロフィール公開中・rejected・未削除・別pendingなし。新申請を作る。NO-05／NO-03 |
| API-NO-12 | POST `/notices/{noticeId}/deletion` | `{expectedVersion,confirmed:true}` | MutationResult、state=deleted | 公開済みの本人。非表示プロフィール・強制非表示中も可。NO-04 |

NoticeContent.titleはTitle、bodyはLongText。categoryCodeはAPI-NO-01の値。OP-08は学校協議・運用上の名称が未確定のため、PoCでは `general`／「お知らせ（仮）」を初期値とする設計判断。カテゴリー編集APIは設けない。

本人一覧のstateは、公開・申請・削除の別属性から該当する条件を作る。公開済みで編集申請がpendingの場合はpublicとpendingの双方に該当し、state=allでは本体1件として返す。rejected／withdrawnは最新の申請状態で判定し、過去履歴だけの一致で本体を列挙しない。unpublishedな新規申請も申請状態から探せる。削除済みはdeletedだけに該当する。強制非表示はpublicationState=hiddenとして一覧・詳細に示す。

一覧はManagedNoticeListItemを返す。詳細で取得可能な内容だけからタイトルを投影し、期限切れの削除済みタイトルを残さない。本人の未公開本体では最新申請版、公開済みでは公開版、削除済みでは保存期間内の削除本体を表示元とし、pendingRequestは別に示す。

取り下げは本人履歴で閲覧専用。却下後再申請の新しい受付日時を採用し、旧却下履歴を保持する。取り下げ済みからの再開・コピーは提供しない。公開後の再申請では現在の公開版を維持する。削除確定時は一般非表示化とpending編集の自動取り下げを同時に行う。

## 9. イベント

| API ID | メソッド・パス | 入力 | 成功data | 認可・関連画面 |
|---|---|---|---|---|
| API-EV-01 | GET `/events` | 一覧条件 | `List<EventListItem>` | 公開版・非強制非表示。EV-01 |
| API-EV-02 | POST `/events` | EventContent | 201 MutationResult、state=public/pending | 全所属・プロフィール公開中。職員即時、在校生・卒業生は申請。EV-03 |
| API-EV-03 | GET `/events/{eventId}` | eventId | PublicEvent | 公開中の予定・終了・中止。未公開・強制非表示は404。EV-02 |
| API-EV-04 | POST `/events/{eventId}/revisions` | `{expectedVersion,content:EventContent}` | MutationResult、state=public/hidden/pending | 本人・プロフィール公開中・公開済み・未終了・未中止・別pendingなし。EV-03 |
| API-EV-05 | GET `/me/events` | 一覧条件 | `List<ManagedEventListItem>` | 本人だけ。EV-04 |
| API-EV-06 | GET `/me/events/{eventId}` | eventId | ManagedContent | 本人だけ、強制非表示中も可。EV-04 |
| API-EV-07 | GET `/me/events/{eventId}/requests` | 一覧条件 | `List<RequestSummary>` | 本人の申請履歴。EV-05 |
| API-EV-08 | GET `/me/event-requests/{requestId}` | requestId | ReviewRequest | 本人の申請本文・結果。EV-05 |
| API-EV-09 | PATCH `/me/event-requests/{requestId}` | `{expectedVersion,content:EventContent}` | MutationResult、state=pending | 本人・プロフィール公開中・pending。版を差し替え、元受付日時を維持。EV-03／EV-05 |
| API-EV-10 | POST `/me/event-requests/{requestId}/withdrawal` | `{expectedVersion}` | MutationResult、state=withdrawn | 本人・プロフィール公開中・pending。EV-05 |
| API-EV-11 | POST `/me/event-requests/{requestId}/resubmission` | `{expectedVersion,content:EventContent}` | 201 MutationResult、state=pending | 本人・プロフィール公開中・rejected・別pendingなし。公開本体があれば未終了・未中止。EV-03／EV-05 |
| API-EV-12 | POST `/events/{eventId}/cancellation` | `{expectedVersion,confirmed:true,reason?}` | MutationResult、state=cancelled | 本人・プロフィール公開中・公開済み・未終了・未中止。EV-04 |

EventContent.titleはTitle、descriptionはLongText。formatはin_person／online／hybrid。対面はvenue、オンラインはparticipationInfo、ハイブリッドは両方必須。venue・participationInfoは最大2,000文字。externalUrlは任意のHTTP／HTTPS URL、最大2,048文字。endsAtとexternalUrlの省略は新規・新しい内容版ではnullとして保存する。各contentは全フィールドを表す入力で、任意フィールドの省略を旧版からの引継ぎとは解釈しない。

終了日時指定時はstartsAtより後。新規申請の開始日は当日以降とし、当日の開始時刻が過ぎていても許可する。過去の開始日の新規申請を修正する場合は、当日以降へ修正する。公開済みイベントの本文編集では開始日が既に過去でも、公開版の有効終了時刻より前であることと日時の整合を確認する。

編集申請の中身を未来の日付へ変えても、公開本体の終了を延長しない。中止・終了後は公開版編集、申請中修正・再申請・審査を拒否し、pending編集申請を自動取り下げる。中止状態・中止理由は変更しない。終了・中止後も登録済みの外部URLを警告付きで表示する。

本人イベント一覧はManagedEventListItemを返す。未公開本体の日時は最新申請版、公開済み本体は公開版を表示元とする。申請フィルターは最新の状態、開催フィルターは公開本体の状態で判定し、複数の条件に該当してもstate=allでは本体を重複させない。

## 10. 通知・通報送信

| API ID | メソッド・パス | 入力 | 成功data | 認可・関連画面 |
|---|---|---|---|---|
| API-NT-01 | GET `/notifications` | 一覧条件 | `List<NotificationView>` | 受信者本人・非停止。GE-06 |
| API-NT-02 | GET `/notifications/unread-count` | なし | `{count:非負整数}` | 同上、現在の表示条件で未読を集計。GE-01／GE-06 |
| API-NT-03 | POST `/notifications/{notificationId}/read` | `{}` | MutationResult、state=read、version=null | 受信者本人・非停止。初回だけreadAt設定。GE-06 |
| API-NT-04 | GET `/notifications/{notificationId}/target` | notificationId | NavigationTarget | 受信者本人・非停止。現在の対象権限を再評価。GE-06 |
| API-MD-01 | POST `/reports` | ReportInput | 201 `{received:true,receivedAt}` | 承認済み・非停止。MD-01 |

通知のGETは既読を更新しない。取り下げ済みお知らせの管理者向け通知はwithdrawnという状態案内だけを返す。管理権限解除等で現在の対象を見る資格がない場合はnot_availableとpath=nullを返し、対象の本文や具体的な状態を返さない。対象画面での再認可も行う。

通知kindはqa_answer_created、qa_comment_created、qa_reply_created、notice_review_requested、notice_review_decided、event_review_requested、event_review_decided、profile_review_decided、qa_hidden、profile_hiddenを使用する。各kindの宛先と発生条件はDB・ER設計書の通知生成規則に従う。public_messageには対象本文を保存せず、汎用メッセージと本人向け理由を用途に応じて設定する。

ReportInputは次の形。プロフィール・アカウントのidはuserId、質問・レスポンスはUUID。reasonはharassment／personal_information／spam／suspicious_url／inappropriate_recruitment／other。detailは省略・null可、最大500文字、otherだけ空白以外の詳細必須。confirmed=true必須。

```json
{
  "target": { "type": "question", "id": "9d362ee0-2c02-4bcb-907d-ddb7a8402c05" },
  "reason": "spam",
  "detail": "同じ宣伝が繰り返し投稿されています。",
  "confirmed": true
}
```

target.typeはquestion／response／profile／account。学校管理者、お知らせ・イベント、取得できない削除済み対象への新規通報は受け付けない。プロフィール非表示中の本人による通報は共通認可条件に従って許可する。一般利用者へ返すのは受付完了だけで、caseId・担当者・優先度・対応状態・対応結果・通報履歴URLを返さない。

同じ対象の未終了案件があれば統合し、対応済み案件へ追加通報を統合しない。再送キーが同じなら同じ受付日時を返し、通報本文と通知を重複作成しない。

## 11. 管理者の投稿審査・公開管理

以下は有効な管理権限を持つ利用者用。自己申請の一覧表示と自己審査禁止を分け、表示した申請のversionで確定する。管理者本人が申請した場合も一覧に残し、canReview=falseを返す。

| API ID | メソッド・パス | 入力 | 成功data | 認可・関連画面 |
|---|---|---|---|---|
| API-AN-01 | GET `/admin/notice-requests` | 審査一覧条件 | `List<RequestSummary>` | 有効な両管理者。取り下げを除外。AD-04 |
| API-AN-02 | GET `/admin/notice-requests/{requestId}` | requestId | ReviewRequest | 有効な両管理者。取り下げは404。AD-05 |
| API-AN-03 | POST `/admin/notice-requests/{requestId}/decision` | ReviewDecision | MutationResult、state=approved/rejected | pending・自己審査不可。却下理由は任意。AD-05 |
| API-AN-04 | GET `/admin/notices` | 公開管理一覧条件 | `List<ManagedNoticeListItem>` | 取得できる本体だけ列挙。削除済み管理一覧は学校管理者のみ。AD-04 |
| API-AN-05 | GET `/admin/notices/{noticeId}` | noticeId | ManagedContent | 学校公式の非表示本文・削除済み本文は学校管理者のみ。AD-05 |
| API-AN-06 | POST `/admin/notices/{noticeId}/visibility` | VisibilityChange | MutationResult、state=hidden/public | 学校公式は学校のみ、卒業生投稿は両管理者。削除済み不可。AD-05 |
| API-AE-01 | GET `/admin/event-requests` | 審査一覧条件 | `List<RequestSummary>` | 有効な両管理者。取り下げを承認待ちから除外。AD-06 |
| API-AE-02 | GET `/admin/event-requests/{requestId}` | requestId | ReviewRequest | 有効な両管理者。履歴は現在の対象権限で取得。AD-07 |
| API-AE-03 | POST `/admin/event-requests/{requestId}/decision` | ReviewDecision | MutationResult、state=approved/rejected | pending・自己審査不可。却下理由必須。AD-07 |
| API-AE-04 | GET `/admin/events` | 公開管理一覧条件 | `List<ManagedEventListItem>` | 取得できる本体だけ列挙。AD-06 |
| API-AE-05 | GET `/admin/events/{eventId}` | eventId | ManagedContent | 職員主催の強制非表示本文は学校管理者のみ。AD-07 |
| API-AE-06 | POST `/admin/events/{eventId}/visibility` | VisibilityChange | MutationResult、state=hidden/public | 職員主催は学校のみ、在校生・卒業生主催は両管理者。終了・中止後も権限内で可。AD-07 |
| API-AQ-01 | POST `/admin/questions/{questionId}/visibility` | VisibilityChange | MutationResult、state=hidden/public | Q&Aの投稿者がアプリ管理者なら学校管理者のみ。未削除。QA-02 |
| API-AQ-02 | POST `/admin/responses/{responseId}/visibility` | VisibilityChange | MutationResult、state=hidden/public | 同上。QA-02 |

ReviewDecisionは `{expectedVersion,decision,reason?}`。decisionはapprove／reject。お知らせのreasonは任意、イベント・プロフィールのrejectは空白以外のReason必須。承認で公開版を切り替えても強制非表示を解除しない。イベントの過去日付の新規申請にはneedsDateCorrection=trueを返し、日付修正前のapprove・rejectを409 STATE_CONFLICTとする。

VisibilityChangeは `{expectedVersion,visibility,reason?,sourceCaseId?}`。visibilityはhidden／public。お知らせ・イベントの理由は任意、Q&Aのhiddenは本人向け通知の理由を必須とする。Q&Aのpublicへの復元理由は任意。お知らせ・イベントにsourceCaseIdは受け付けない。

管理者によるQ&Aの非表示は理由通知、投稿の強制非表示・復元は監査記録を確定する。お知らせ・イベントの強制非表示・復元では投稿者へ個別通知しない。卒業生兼アプリ管理者の自分のお知らせと、在校生・卒業生兼アプリ管理者の自分のイベントは強制非表示・復元を許可する。自己審査は禁止する。

sourceCaseIdを受け付ける措置では、案件の閲覧権限・未終了を確認する。Q&A措置は案件対象そのものの質問・レスポンスに限り、停止・プロフィール非表示は案件対象の本人に限る。案件の対応履歴も同時記録する。対応済み案件をsourceCaseIdに指定した操作は409 CASE_CLOSED。案件と別の対象に対する管理操作を、他の案件の履歴へ記録しない。

## 12. ユーザー管理・再公開審査

| API ID | メソッド・パス | 入力 | 成功data | 認可・関連画面 |
|---|---|---|---|---|
| API-US-01 | GET `/admin/users` | 管理ユーザー一覧条件 | `List<AdminUserSummary>` | 有効な両管理者。AD-10 |
| API-US-02 | GET `/admin/users/{userId}` | userId | AdminUser | 有効な両管理者、対象者別の返却条件を適用。AD-11 |
| API-US-03 | GET `/admin/users/{userId}/identity` | userId | IdentityRecord | 学校管理者のみ。AD-11 |
| API-US-04 | POST `/admin/users/{userId}/suspension` | SuspensionChange | MutationResult、state=suspended/active | 一般対象は両管理者、アプリ管理者対象は学校のみ。学校管理者対象不可。AD-11 |
| API-US-05 | POST `/admin/users/{userId}/profile-hiding` | ProfileHiding | MutationResult、state=hidden | 一般対象は両管理者、アプリ管理者対象は学校のみ。学校管理者対象不可。AD-11 |
| API-US-06 | POST `/admin/users/{userId}/app-manager-role` | `{expectedVersion,assigned:boolean}` | MutationResult、state=assigned/revoked | 学校管理者のみ。学校管理者ロールを変更しない。AD-11 |
| API-PR-01 | GET `/admin/profile-reviews` | 審査一覧条件 | `List<ProfileReviewSummary>` | 有効な両管理者。対象がアプリ管理者なら学校のみ。AD-15 |
| API-PR-02 | GET `/admin/profile-reviews/{reviewId}` | reviewId | ProfileReview | 同上。公開予定項目だけ。AD-15 |
| API-PR-03 | POST `/admin/profile-reviews/{reviewId}/decision` | ReviewDecision | MutationResult、state=approved/rejected | 対象者別権限・pending・表示版の一致。却下理由必須。AD-15 |

SuspensionChangeは `{expectedVersion,suspended,publicReason,internalReason,sourceCaseId?}`。publicReason・internalReasonは空白以外のReason必須。解除も両方保存し、本人にはpublicReasonだけを返す。現在と同じ停止状態への新しい操作は409 STATE_CONFLICTとし、理由だけを書き換える操作にしない。

ProfileHidingは `{expectedVersion,reason,sourceCaseId?}`。reasonは本人向けの空白以外のReason必須。publicからhiddenへ変更し、必要な管理案件の引継ぎを同時に行う。公開への復帰は本人修正保存後の再公開審査で行う。プロフィールの審査中再編集を許可し、古いreview.versionでの決定を拒否する。

assignedの変更は、利用資格確認済み・発行完了の利用者を対象とする。アプリ管理者の権限解除ではログインと基本所属を維持し、管理機能を失った担当者の未終了案件を引き継ぐ。対象者への付与で案件が学校専用になる場合も、現在の対象区分に合わせてアクセスと担当を調整する。

| DTO | フィールド・返却条件 |
|---|---|
| AdminUserSummary | userId、displayName、baseRole、isGraduating、accountStatus、profileState、roles={schoolManager,appManager}、version |
| AdminUser | AdminUserSummaryの全フィールド、capabilities={canSuspend,canResume,canHideProfile,canChangeAppManager,canViewIdentity}、suspensionReason/null。理由は対象への停止管理権限がある場合だけ `{publicReason,internalReason}` として返す |
| IdentityRecord | userId、privateRealName/null、schoolReference/null、email、emailVerified、verificationNote/null。学校専用。認証ハッシュ・セッション秘密値は返さない |

停止中の対象への操作は、操作する管理者自身が有効であることを確認して行う。プロフィール再公開承認や停止解除は、他の停止・権限解除等の制限を自動解除しない。

## 13. 通報案件・引継ぎ・証拠

| API ID | メソッド・パス | 入力 | 成功data | 認可・関連画面 |
|---|---|---|---|---|
| API-RP-01 | GET `/admin/report-cases` | 案件一覧条件 | `List<ReportCaseSummary>` | 有効な管理者の取得可能な案件のみ。AD-08 |
| API-RP-02 | GET `/admin/report-cases/{caseId}` | caseId | ReportCase | 対象者区分・schoolOnly・引継ぎ・保存期限を適用。AD-09 |
| API-RP-03 | PATCH `/admin/report-cases/{caseId}` | CasePatch | MutationResult | 未終了案件の状態・優先度。対応済みは409。AD-09 |
| API-RP-04 | POST `/admin/report-cases/{caseId}/assignment` | `{expectedVersion,assigneeId}` | MutationResult | 最新状態で対応可能な担当1人を設定。引継ぎ待ちは学校のみ。AD-09／AD-16 |
| API-RP-05 | POST `/admin/report-cases/{caseId}/notes` | `{expectedVersion,note}` | MutationResult | 未終了・権限内案件へReason型の対応メモを追記。AD-09 |
| API-RP-06 | GET `/admin/report-cases/{caseId}/actions` | 一覧条件 | `List<ReportAction>` | 親案件と同じ取得権限。AD-09 |
| API-RP-07 | GET `/admin/report-cases/{caseId}/reports` | 一覧条件 | `List<ReportSubmission>` | 通報者情報と削除済み対象の制限を適用。AD-09 |
| API-RP-08 | GET `/admin/report-cases/{caseId}/evidence` | 一覧条件 | `List<EvidenceSummary>` | 削除済み対象の証拠は学校のみ。AD-09／AD-17 |
| API-RP-09 | GET `/admin/report-cases/{caseId}/evidence/{evidenceId}` | caseId、evidenceId | EvidenceSnapshot | 案件と証拠の関連・現在の削除状態・期限を確認。AD-17 |
| API-RP-10 | GET `/admin/report-cases/handoffs` | 一覧条件 | `List<ReportCaseSummary>` | 学校管理者のみ。未終了の引継ぎ待ち。AD-16 |
| API-RP-11 | GET `/admin/report-cases/{caseId}/assignment-candidates` | 一覧条件 | `List<AssigneeCandidate>` | 同案件の割当権限があり、未終了であること。AD-09／AD-16 |

CasePatchは `{expectedVersion,status?,priority?}` で、status・priorityの少なくとも1つを指定する。statusはunhandled／in_progress／closed、priorityはunset／normal／high。未終了案件の間で状態を変更でき、closedへ遷移すると以後の状態・優先度・担当・メモ・案件に結び付ける措置の変更を拒否する。別の未終了案件や独立した対象管理操作には、その対象の権限を適用する。

引継ぎ待ちを学校管理者がclosedへ変更する場合は、assigneeIdを実行者に設定し、handoffPending=false・closedAtの設定・対応履歴・監査を同時確定する。事前に別の担当設定APIを呼ぶことを完了の必須条件にしない。

assigneeId=nullは利用者の入力として許可しない。担当者の停止・プロフィール非表示・権限解除や、対象の削除・学校専用化で担当不能になった場合の未割当はシステムの引継ぎ処理だけで作る。割当候補APIが返した後も、割当時に資格を再確認する。closedAtは閉じた時刻を保持し、案件の保存期限をその時刻から1年とする。閲覧専用でも、現在の対象権限・学校専用制限・証拠の削除状態は取得時に適用する。

| DTO | フィールド・返却条件 |
|---|---|
| ReportCaseSummary | id、target={type,id,subjectUserId,label/null,sourceState}、status、priority、assignee:PublicAuthor/null、handoffPending、schoolOnly、reportCount、version、createdAt、updatedAt、closedAt/null。labelは現在取得できる公開名・タイトルのみ |
| ReportCase | ReportCaseSummaryの全フィールド、capabilities={canUpdate,canAssign,canAddNote,canViewEvidence,canViewIdentity}。通報本文・証拠本文は専用APIから取得 |
| ReportAction | id、actor:PublicAuthor/null、systemAction、actionType、beforeState、afterState、note/null、noteRedacted:boolean、createdAt。beforeState／afterStateは状態・優先度・担当等の許可した変更項目のみ |
| ReportSubmission | id、reason、detail/null、detailRedacted:boolean、reporter:PublicAuthor、createdAt。学校管理者の本人確認情報はAPI-US-03で別取得 |
| AssigneeCandidate | userId、displayName、roles、userVersion。案件を現在対応可能な有効管理者だけ |
| EvidenceSummary | id、targetType、capturedAt、sourceDeleted:boolean、retentionExpiresAt/null。本文なし |
| EvidenceSnapshot | EvidenceSummaryの全フィールド、content。questionはtitle・bodyMarkdown・authorLabel、responseはbodyMarkdown・authorLabel・kind・questionId・parentResponseId、profileは取得可能な公開プロフィール項目、accountは公開名・利用者ID・基本所属の情報だけ |

アプリ管理者は閲覧可能な通常案件の通報者公開名・IDまで。本人確認情報を結合して返さない。対象が削除済みの場合は、アプリ管理者向けReportSubmission.detailとReportAction.noteをnullにし、それぞれのRedactedフラグをtrueとする。引用された削除済み本文から証拠閲覧を迂回させない。削除済み証拠の取得は担当者本人でも学校管理者だけ。

証拠はcaseIdとの関連付けを確認して返す。他の案件のevidenceIdを指定しても取得できない。対象の親投稿が削除済みの場合に、残存回答の証拠へ削除済み親本文を追加しない。証拠の保存期限は同じtargetIdの関連全案件に基づき、未終了案件があれば期限を確定しない。案件1年・削除済み証拠180日・操作ログ1年の期限は独立して判定する。

## 14. 卒業区分変更・監査・管理ホーム

| API ID | メソッド・パス | 入力 | 成功data | 認可・関連画面 |
|---|---|---|---|---|
| API-GR-01 | GET `/admin/graduation/candidates` | 一覧条件、mode=graduate/correction、q、department、graduationYear | `List<GraduationCandidate>` | 学校のみ。graduateは卒業予定の在校生、correctionは在校生・卒業生。AD-13 |
| API-GR-02 | POST `/admin/graduation/changes` | GraduationBatch | 201 MutationResult、state=applied、affectedCount | 学校のみ、全対象を原子的に変更。AD-13 |
| API-GR-03 | POST `/admin/graduation/corrections` | GraduationCorrection | 201 MutationResult、state=corrected、affectedCount=1 | 学校のみ、在校生／卒業生内の指定修正。AD-13 |
| API-GR-04 | GET `/admin/graduation/changes` | 一覧条件、userId、batchId | `List<GraduationChange>` | 学校のみ。AD-13 |
| API-AD-01 | GET `/admin/dashboard` | なし | AdminDashboard | 有効な管理者、対応可能な対象だけ。AD-01 |
| API-LOG-01 | GET `/admin/audit-logs` | 一覧条件 | `List<AuditLog>` | 学校のみ。AD-14（補完設計案） |
| API-LOG-02 | GET `/admin/audit-logs/{logId}` | logId | AuditLog | 学校のみ、操作から1年未満。AD-14（補完設計案） |

GraduationBatchは `{targets:[{userId,expectedVersion}],confirmed:true}`。1〜100人、IDの重複不可。全対象が現在もstudentかつisGraduating=trueであることを確認し、baseRole=alumni・isGraduating=falseへ変更する。1人でも版・資格が違えば全体を409として確定しない。上限を超える人数は別操作として対象を選び直す。

GraduationCorrectionは `{userId,expectedVersion,baseRole,isGraduating,confirmed:true}`。baseRoleはstudent／alumni。alumniでisGraduating=trueは422。現在の対象もstudent／alumniに限定し、staff・管理権限・利用者IDを変更しない。指定した新状態と変更前の状態を履歴へ残す。

| DTO | フィールド・返却条件 |
|---|---|
| GraduationCandidate | userId、displayName、baseRole、isGraduating、department、entryYear、graduationYear、version |
| GraduationChange | id、batchId、userId、actor:PublicAuthor、changeKind=graduation/correction、before={baseRole,isGraduating}、after={baseRole,isGraduating}、createdAt |
| AdminDashboard | counts={noticeRequests,eventRequests,unhandledReports}、navigation={canViewNotices,canViewEvents,canViewReports,canViewUsers,canViewGraduation,canViewAuditLogs,canViewProfileReviews,canViewHandoffs} |
| AuditLog | id、actor:PublicAuthor/null、systemAction、actionType、target={type,id}、beforeState、afterState、publicReason/null、createdAt。beforeState／afterStateは操作ごとの状態・所属・権限フラグ等の許可した差分だけ |

管理カードは自己審査できない自己申請と、閲覧・対応できない通報案件を集計から除外する。学校管理者の未対応件数には、学校専用・引継ぎ待ちの未対応案件も含める。登録申請カード、直近案件詳細、リアルタイム自動更新はPoC対象外。

監査ログのAPIは取得だけを定義し、編集・削除を公開しない。秘密値・ハッシュ・セッショントークン・投稿本文・本人確認情報をログのbeforeState／afterStateへコピーしない。

## 15. 画面とAPIの対応

35管理単位の対応を示す。すべての認証後画面でAPI-COM-01による利用状態確認を共有し、ログアウトはAPI-AUTH-03を利用する。表のIDは本書のAPI ID。

| 画面ID | 主なAPI |
|---|---|
| AU-01 | API-AUTH-01〜03、API-COM-01 |
| GE-01 | API-COM-02、API-NT-02 |
| GE-02 | API-PRO-01〜02 |
| GE-03 | API-PRO-03、API-MD-01 |
| GE-04 | API-PRO-04 |
| GE-05 | API-QA-13、API-QA-04、API-QA-09 |
| GE-06 | API-NT-01〜04 |
| QA-01 | API-QA-01〜02 |
| QA-02 | API-QA-04、API-QA-06〜12、API-MD-01、API-AQ-01〜02 |
| QA-03 | API-QA-01、API-QA-03〜05 |
| NO-01 | API-NO-02 |
| NO-02 | API-NO-04 |
| NO-03 | API-NO-01、API-NO-03、API-NO-05、API-NO-07、API-NO-09、API-NO-11 |
| NO-04 | API-NO-06〜08、API-NO-12 |
| NO-05 | API-NO-08〜11 |
| EV-01 | API-EV-01 |
| EV-02 | API-EV-03 |
| EV-03 | API-EV-02、API-EV-04、API-EV-06、API-EV-08〜09、API-EV-11 |
| EV-04 | API-EV-05〜07、API-EV-12 |
| EV-05 | API-EV-07〜11 |
| MD-01 | API-MD-01 |
| AD-01 | API-AD-01 |
| AD-04 | API-AN-01、API-AN-04 |
| AD-05 | API-AN-02〜03、API-AN-05〜06 |
| AD-06 | API-AE-01、API-AE-04 |
| AD-07 | API-AE-02〜03、API-AE-05〜06 |
| AD-08 | API-RP-01 |
| AD-09 | API-RP-02〜09、API-RP-11、API-AQ-01〜02、API-US-04〜05 |
| AD-10 | API-US-01 |
| AD-11 | API-US-02〜06 |
| AD-13 | API-GR-01〜04 |
| AD-14 | API-LOG-01〜02。補完設計案を実装する場合 |
| AD-15 | API-PR-01〜03 |
| AD-16 | API-RP-10〜11、API-RP-04、API-RP-03 |
| AD-17 | API-RP-08〜09、本人確認情報が必要な場合のみAPI-US-03 |

AU-02〜05、AD-02、AD-03、AD-12は予約ID。PoCの画面・APIを追加しない。アカウント発行・再発行は開発担当のコマンドで行い、公開HTTP管理APIを作らない。

## 16. 呼出例と更新結果

### 卒業生のお知らせ新規申請

`POST /api/v1/notices`。認証Cookie、Content-Type、許可したOrigin、`Idempotency-Key: 0f68488a-6c9b-4d3c-a799-8821f96998c1`を付ける。

```json
{
  "title": "進路相談会のお知らせ",
  "body": "卒業生による進路相談会を開催します。",
  "categoryCode": "general"
}
```

201の応答例。

```json
{
  "data": {
    "operationId": "a6fb6940-c297-4371-b548-af877bc4df9c",
    "resource": { "type": "notice_request", "id": "7181d057-91ca-484b-8146-c39b15d49e6a" },
    "version": 1,
    "state": "pending",
    "committedAt": "2026-11-12T03:00:00.000Z"
  },
  "meta": {
    "requestId": "7b19476f-4c67-4b49-84dc-fc0be40da952",
    "serverTime": "2026-11-12T03:00:00.000Z"
  }
}
```

画面はAPI-NO-09で申請を取得し、resourceIdを使ってNO-04内の申請詳細を開く。同じキー・本文の再送には同じoperationId・resource・version・state・committedAtを返す。meta.requestId・serverTimeは現在の応答値、meta.replayed=trueとする。

### 更新結果の対象

MutationResult.versionはresourceが示す対象の版とする。複数の対象を同時に変更した場合も、画面が次に取得する主対象を1つ指定し、他の対象の最新値は再取得する。

| 操作 | resource.typeとid | version・state |
|---|---|---|
| 本人プロフィール保存 | profile、本人userId | profiles.version、public/hidden。再公開審査はMyProfile.reviewで取得 |
| Q&A作成・編集・削除・管理非表示 | questionまたはresponse、投稿ID | 本体version、publicationState。解決状態変更だけopen/resolved |
| 職員のお知らせ・イベント作成／内容更新 | noticeまたはevent、本体ID | 本体version、public。強制非表示中の内容更新はhidden |
| 審査が必要な新規・編集・再申請、申請中修正・取り下げ・決定 | notice_requestまたはevent_request、申請ID | 申請version、pending/withdrawn/approved/rejected |
| お知らせ削除、イベント中止、公開管理の非表示・復元 | noticeまたはevent、本体ID | 本体version、deleted/cancelled/hidden/public |
| 利用者停止・プロフィール非表示・管理権限変更 | user、対象userId | community_users.version、各APIの結果状態。プロフィール非表示は関連profiles.versionも更新し再取得 |
| プロフィール再公開決定 | profile_review、審査ID | 審査version、approved/rejected |
| 案件の状態・担当・メモ更新 | report_case、案件ID | 案件version、更新後の案件status |
| 通知既読 | notification、通知ID | null、read |
| 卒業一括変更・指定修正 | graduation_batch、batchId | null、applied/corrected。履歴APIでbatchIdを指定して取得 |

### 引継ぎ待ち案件の完了

`PATCH /api/v1/admin/report-cases/{caseId}` に新しい再送キーと次の本文を送る。

```json
{ "expectedVersion": 7, "status": "closed" }
```

学校管理者が実行した場合、同じトランザクションで担当を実行者へ設定し、引継ぎ待ち解除・closedAt設定・版更新・履歴・監査・再送記録を確定する。途中で失敗すればすべて確定しない。以後、新しいキーでメモ・担当・優先度・状態を変更する要求は409 CASE_CLOSED。同じ完了操作の正しい再送だけは、現在の取得資格を確認して最初の結果を返す。

### 卒業区分の指定修正

`POST /api/v1/admin/graduation/corrections` の例。卒業生から卒業予定の在校生へ修正する場合。

```json
{
  "userId": "poc-student-01",
  "expectedVersion": 4,
  "baseRole": "student",
  "isGraduating": true,
  "confirmed": true
}
```

利用者ID・過去投稿・プロフィール版・管理権限は維持し、変更前後とchangeKind=correctionを履歴へ保存する。履歴1件の単純な取り消しを条件とせず、学校管理者が指定した区分へ修正する。

## 17. 実装時の受入確認

以下は実装後にAPI・DBを含めて確認する項目。本書の作成時点ではAPIの実装・実行試験は行っていない。

| 確認対象 | 期待結果 |
|---|---|
| 認証入口 | 未認証401、発行／学校確認未完了403。停止中は本人状態案内・ログアウトだけ許可。内部メール・ハッシュを業務DTOへ漏らさない |
| 認証の許可経路 | SDKの必要経路だけ利用可能。登録・回復・メールログイン等の直接呼出しで学校発行を迂回できない |
| Cookie・更新保護 | HTTPS Cookieと固定8時間期限を確認。不正／欠落Origin、JSON以外、未知フィールド、過大本文、未定義メソッドを拒否 |
| 対象の認可 | 本人用ID、他案件の証拠ID、学校専用対象を差し替えても取得・変更できない。403／404の前に固有の状態・版番号を漏らさない |
| 詳細公開設定 | self項目を一般プロフィール・検索・件数・審査・証拠へ混ぜない。表示名や本文を安全に表示し、Markdownの生HTMLを実行しない |
| プロフィール非表示 | 検索除外、新規・編集・アプリ管理操作の拒否。本人修正・既存投稿削除・通常閲覧・通報・通知既読は許可。学校管理者は非表示操作対象外 |
| 審査競合 | 同じ版を2人が審査しても一方だけ確定。イベント／プロフィールの申請修正後、旧版の審査は409。自己審査を拒否 |
| 公開版と申請版 | 編集申請のpending・rejected・withdrawnで旧公開版を維持。一般API・検索へ申請本文を返さず、承認で強制非表示を解除しない |
| 取り下げ通知・履歴 | お知らせ管理者には本文を返さず状態案内だけ。本人は履歴を閲覧でき、取り下げからの再開・コピーはできない |
| Q&A削除 | 親本文を隠し、残存する子を個別認可。削除済み親への直接投稿を拒否し、子を連鎖削除しない。アプリ管理者投稿の管理措置は学校のみ |
| イベント時刻 | JSTの当日／翌日境界、終了指定なし、ロック待ち中の終了を確認。終了・中止時にpending編集を取り下げ、内容編集・中止理由変更を拒否 |
| 通報統合・完了 | 同一対象への同時通報でも未終了案件は最大1件。対応済み案件は閲覧専用。後続通報は新案件。引継ぎ待ち完了で実行者を担当設定 |
| 即時の権限変更 | 停止・非表示・管理権限解除後の旧タブや再送でも拒否。担当不能な未終了案件を引継ぎ、一般利用資格と管理権限を混同しない |
| 期限 | 削除お知らせ180日、案件1年、削除済み証拠180日、ログ1年の境界で一覧・詳細・履歴・通知経由を検査。削除証拠は担当者でも学校のみ |
| 再送・障害 | 通信切断後の再送で二重投稿・二重履歴・二重通知なし。同じキーの別本文は409。途中失敗は業務変更と記録をまとめてロールバック |
| 一覧 | 権限外対象を件数・カーソルへ含めない。条件変更したカーソルを拒否。同値の並び、同時更新、ページ間の権限変更を確認 |
| 卒業変更 | 全対象の版・資格を確認し、1人の競合で全体を未確定にする。指定修正の前後・操作者・区分を保存し、職員・管理権限を変更しない |

## 18. 実装順と残る確認

| ロードマップ段階 | 本書から実装する契約 |
|---|---|
| 03 開発基盤 | Route Handlers、共通JSON・エラー、入力スキーマ、Origin保護、認可サービス、DBトランザクション・再送記録の共通処理 |
| 04 ログイン・権限・プロフィール | AUTH・COM-01・PRO・GR、関連するUS・PR。SDK経路と生成認証モデルの照合、架空アカウントの発行・再発行コマンド |
| 05 Q&A | QA、MD・AQの必要部分、通知生成。最初の通報受領と管理非表示を接続 |
| 06 お知らせ | NO・AN。新規・編集審査、旧版維持、削除の期限 |
| 07 イベント | EV・AE。審査中修正、開催時刻、中止・終了の同期 |
| 08 安全管理・監査 | RP・US・PR・AQの全条件と引継ぎ、学校専用取得、採用する場合はLOG |
| 09 通知・ホーム | COM-02・NTを含め全導線を接続 |
| 10 総合検証・実演 | 17節の条件を架空データとAPI・DBで検証し、実演手順を確認 |

Next.js・Better Auth等の正確な採用バージョンと生成モデルは基盤構築時に固定する。SDKの経路・戻り値・Cookie設定は固定版の公式仕様と照合する。差異があれば認証の接続部分を更新し、本書の業務認可を維持する。

認証回数制限の閾値は技術決定書9節に従い基盤構築で確定する。複数実行環境で同じ制限になるようDB保存を使用し、制限超過時の429・Retry-Afterとログイン失敗表示を確認する。

OP-05等の学校協議事項とOP-08の正式カテゴリー名は原資料で管理する。PoCの架空データと仮カテゴリーで実装できる契約を本書に定義済み。実データを使う段階では学校側の決定を反映する。将来の外部クライアント、ファイル添付、公開登録、MFA等を必要とする場合は、PoCとは別にAPI契約を追加する。
