import type { Metadata } from "next";
import Link from "next/link";
import {
  listGraduationCandidates, listGraduationChanges, loadCorrectionCandidate, parseGraduationCandidateQuery,
  parseGraduationChangeQuery, type GraduationCandidate, type GraduationChangeListItem,
} from "@/admin/graduation";
import { userId as userIdSchema } from "@/api/request";
import { ApiError, type PageInfo } from "@/api/response";
import type { Viewer } from "@/auth/access";
import type { ScreenSearchParams } from "@/auth/screen";
import { AdminAccessDenied } from "@/components/app-shell/AdminAccessDenied";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAdminScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import admin from "../admin.module.css";
import { formatDateTime } from "../labels";
import { candidateFilterErrors, candidateFilterNames, type CandidateFilterValues } from "./candidate-filters";
import { CandidateSearchForm } from "./candidate-search-form";
import { CorrectionPanel } from "./correction-panel";
import { GraduatePanel } from "./graduate-panel";
import { graduationModeLabels, graduationModes, graduationPath, type GraduationMode } from "./graduation-path";
import { nameLabel, stateLabel } from "./labels";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "卒業区分の変更" };

/** 一括変更の候補を一度に表示する人数（API の上限）。 */
const candidatePageSize = "50";
const invalidConditions = "一覧の条件を確認してください。";

type Params = { values: Record<string, string>; malformed: boolean };
type ViewProps = { viewer: Viewer; params: Params };

/** 画面のクエリーから値を取り出す。空欄は指定なし、同名の複数指定は形式の誤りとして扱う。 */
function readParams(searchParams: ScreenSearchParams): Params {
  const values: Record<string, string> = {};
  let malformed = false;
  for (const name of ["mode", "cursor", "user", "userId", "batchId", ...candidateFilterNames]) {
    const raw = searchParams[name];
    if (Array.isArray(raw)) malformed = true;
    else if (raw !== undefined && raw.trim() !== "") values[name] = raw;
  }
  return { values, malformed };
}

type Loaded<T> = { kind: "ok"; items: T[]; page: PageInfo } | { kind: "invalid"; message: string };

async function load<T>(
  params: Params, read: Parameters<typeof readForScreen<{ data: { items: T[] }; page: PageInfo }>>[0],
): Promise<Loaded<T>> {
  if (params.malformed) return { kind: "invalid", message: invalidConditions };
  try {
    const { data, page } = await readForScreen(read);
    return { kind: "ok", items: data.items, page };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return {
      kind: "invalid",
      message: error.code === "INVALID_CURSOR"
        ? "一覧の続きを表示できませんでした。最初のページから表示し直してください。" : invalidConditions,
    };
  }
}

function apiUrl(params: Record<string, string | undefined>): URL {
  const url = new URL("http://app/");
  for (const [name, value] of Object.entries(params)) if (value) url.searchParams.set(name, value);
  return url;
}

function filterValues(params: Params): CandidateFilterValues {
  return Object.fromEntries(candidateFilterNames.map((name) => [name, params.values[name]]));
}

function Invalid({ message, firstPage }: { message: string; firstPage: string }) {
  return (
    <div className={admin.formError} role="alert">
      <p>{message}</p>
      <Link href={firstPage}>最初のページを表示する</Link>
    </div>
  );
}

/** 一覧が空のとき、または続きのページに表示するものがないときの案内。 */
function Empty({ page, message, firstPage }: { page: PageInfo; message: string; firstPage: string }) {
  if (page.totalCount === 0) return <p className={admin.text}>{message}</p>;
  return (
    <p className={admin.text}>
      このページに表示できるものはありません。<Link href={firstPage}>最初のページを表示する</Link>
    </p>
  );
}

/** 一括変更：卒業予定の在校生を探して選ぶ。 */
async function GraduateView({ viewer, params }: ViewProps) {
  const values = filterValues(params);
  const errors = candidateFilterErrors(values);
  const query = apiUrl({ ...values, mode: "graduate", limit: candidatePageSize });
  const result = Object.keys(errors).length ? null
    : await load(params, async (db) => listGraduationCandidates(db, viewer, parseGraduationCandidateQuery(query)));
  const firstPage = graduationPath("graduate", values);
  return (
    <>
      <section className={admin.card} aria-label="検索">
        <CandidateSearchForm key={firstPage} mode="graduate" values={values} errors={errors} />
      </section>
      {result?.kind === "invalid" ? <Invalid message={result.message} firstPage={graduationPath("graduate")} /> : null}
      {result?.kind === "ok" ? (
        <GraduatePanel
          key={firstPage}
          items={result.items}
          nextCursor={result.page.nextCursor}
          totalCount={result.page.totalCount}
          apiQuery={query.searchParams.toString()}
        />
      ) : null}
    </>
  );
}

/** 修正：在校生・卒業生から1人を選び、区分を指定する。 */
async function CorrectionView({ viewer, params }: ViewProps) {
  const values = filterValues(params);
  const errors = candidateFilterErrors(values);
  const { cursor, user } = params.values;

  let selected: GraduationCandidate | "not_found" | null = null;
  if (user) {
    try {
      selected = userIdSchema.safeParse(user).success
        ? await readForScreen((db) => loadCorrectionCandidate(db, user)) : "not_found";
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "NOT_FOUND") throw error;
      selected = "not_found";
    }
  }
  const candidate = selected === "not_found" ? null : selected;
  const query = apiUrl({ ...values, mode: "correction", cursor });
  const result = Object.keys(errors).length ? null
    : await load(params, async (db) => listGraduationCandidates(db, viewer, parseGraduationCandidateQuery(query)));
  const firstPage = graduationPath("correction", values);
  return (
    <>
      {selected === "not_found" ? (
        <section className={admin.card} aria-label="選択した利用者">
          <p className={admin.text} role="alert">この利用者の区分は修正できません。</p>
        </section>
      ) : null}
      {candidate ? (
        <CorrectionPanel
          key={candidate.userId} candidate={candidate} closeHref={graduationPath("correction", { ...values, cursor })}
        />
      ) : null}
      <section className={admin.card} aria-labelledby="correction-list">
        <h2 id="correction-list" className={admin.sectionTitle}>
          在校生・卒業生{result?.kind === "ok" ? <span className={admin.count}>{result.page.totalCount}人</span> : null}
        </h2>
        <CandidateSearchForm key={firstPage} mode="correction" values={values} errors={errors} />
        {result?.kind === "invalid" ? <Invalid message={result.message} firstPage={firstPage} /> : null}
        {result?.kind === "ok" && result.items.length === 0
          ? <Empty page={result.page} message="条件に合う在校生・卒業生はいません。" firstPage={firstPage} /> : null}
        {result?.kind === "ok" && result.items.length > 0 ? (
          <ul className={admin.list}>
            {result.items.map((item) => (
              <li key={item.userId} className={admin.listItem}>
                <span className={admin.badgeInfo}>{stateLabel(item)}</span>
                <Link
                  className={admin.itemLink}
                  href={graduationPath("correction", { ...values, cursor, user: item.userId })}
                  aria-current={candidate?.userId === item.userId ? "true" : undefined}
                >
                  {nameLabel(item.displayName)}
                </Link>
                <span className={admin.meta}>
                  {item.department ?? "学科未設定"}・卒業年度：{item.graduationYear ?? "未設定"}・ID：{item.userId}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {result?.kind === "ok" && result.page.nextCursor ? (
          <p className={admin.links}>
            <Link href={graduationPath("correction", { ...values, cursor: result.page.nextCursor })}>次のページ</Link>
          </p>
        ) : null}
      </section>
    </>
  );
}

/** 変更履歴：変更前後・実行者・日時を新しい順に表示する。 */
async function HistoryView({ viewer, params }: ViewProps) {
  const { cursor, userId, batchId } = params.values;
  const result: Loaded<GraduationChangeListItem> = await load(params, async (db) =>
    listGraduationChanges(db, viewer, parseGraduationChangeQuery(apiUrl({ cursor, userId, batchId }))));
  const firstPage = graduationPath("history", { userId, batchId });
  return (
    <section className={admin.card} aria-labelledby="history-list">
      <h2 id="history-list" className={admin.sectionTitle}>
        変更の一覧{result.kind === "ok" ? <span className={admin.count}>{result.page.totalCount}件</span> : null}
      </h2>
      {userId || batchId ? (
        <p className={admin.text}>
          {batchId ? "1回の操作の変更だけを表示しています。" : "1人の利用者の変更だけを表示しています。"}
          <Link href={graduationPath("history")}>すべての履歴を表示する</Link>
        </p>
      ) : null}
      {result.kind === "invalid" ? <Invalid message={result.message} firstPage={graduationPath("history")} /> : null}
      {result.kind === "ok" && result.items.length === 0
        ? <Empty page={result.page} message="変更履歴はありません。" firstPage={firstPage} /> : null}
      {result.kind === "ok" && result.items.length > 0 ? (
        <ul className={admin.list}>
          {result.items.map(({ change, displayName }) => (
            <li key={change.id} className={styles.change}>
              <p>
                <span className={change.changeKind === "graduation" ? admin.badgeInfo : admin.badgeWarning}>
                  {change.changeKind === "graduation" ? "一括変更" : "修正"}
                </span>{" "}
                <Link href={graduationPath("history", { userId: change.userId })}>{nameLabel(displayName)}</Link>
                <span className={admin.meta}>（ID：{change.userId}）</span>
              </p>
              <p className={styles.changeState}>{stateLabel(change.before)} → {stateLabel(change.after)}</p>
              <p className={admin.meta}>{formatDateTime(change.createdAt)}・実行者：{change.actor.displayName}</p>
              <p className={admin.links}>
                <Link href={graduationPath("history", { batchId: change.batchId })}>同じ操作の変更を表示</Link>
                <Link href={graduationPath("correction", { user: change.userId })}>この利用者の区分を修正</Link>
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {result.kind === "ok" && result.page.nextCursor ? (
        <p className={admin.links}>
          <Link href={graduationPath("history", { userId, batchId, cursor: result.page.nextCursor })}>次のページ</Link>
        </p>
      ) : null}
    </section>
  );
}

/** AD-13 卒業区分一括変更・修正。学校管理者だけが利用する（#8 ⑥）。 */
export default async function GraduationPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const resolved = await searchParams;
  const { viewer, shell, access } = await requireAdminScreen("school", "/admin/graduation", resolved);
  if (access === "denied") return <AppShell viewer={shell}><AdminAccessDenied /></AppShell>;

  const params = readParams(resolved);
  const mode: GraduationMode = graduationModes.find((value) => value === params.values.mode) ?? "graduate";
  // 機能ごとに別の部品として描画し、切り替えたときに前の入力・選択を残さない。
  const View = { graduate: GraduateView, correction: CorrectionView, history: HistoryView }[mode];
  return (
    <AppShell viewer={shell}>
      <div className={admin.page}>
        <header className={admin.header}>
          <p className={admin.area}>管理エリア</p>
          <h1 className={admin.title}>卒業区分の変更</h1>
          <p className={admin.lead}>卒業予定の在校生を卒業生へ変更し、誤った変更を修正します。変更は履歴に残ります。</p>
        </header>
        <nav aria-label="卒業区分の操作">
          <ul className={admin.filters}>
            {graduationModes.map((value) => (
              <li key={value}>
                <Link className={admin.filter} href={graduationPath(value)} aria-current={value === mode ? "page" : undefined}>
                  {graduationModeLabels[value]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <View viewer={viewer} params={params} />
      </div>
    </AppShell>
  );
}
