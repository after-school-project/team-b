import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ApiError, type PageInfo } from "@/api/response";
import type { Viewer } from "@/auth/access";
import type { ScreenSearchParams } from "@/auth/screen";
import { AdminAccessDenied } from "@/components/app-shell/AdminAccessDenied";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAdminScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import {
  listAdminNoticeRequests, listAdminNotices, parseAdminNoticeQuery, parseAdminNoticeRequestQuery,
} from "@/notices/admin";
import styles from "../admin.module.css";
import { formatDateTime } from "../labels";
import { originLabels, publicationBadge, publicationLabels, requestKindLabels, reviewBadge, reviewLabels } from "./labels";

export const metadata: Metadata = { title: "お知らせの審査・公開管理" };

const listPath = "/admin/notices";
type View = "review" | "publication";

function listHref(filters: Record<string, string>) {
  const query = new URLSearchParams(filters);
  return query.size ? `${listPath}?${query}` : listPath;
}

function Filters<Value extends string>({ label, values, current, labels, href }: {
  label: string;
  values: readonly Value[];
  current: Value;
  labels: Record<Value, string>;
  href: (value: Value) => string;
}) {
  return (
    <nav aria-label={label}>
      <ul className={styles.filters}>
        {values.map((value) => (
          <li key={value}><Link className={styles.filter} href={href(value)}
            aria-current={current === value ? "page" : undefined}>{labels[value]}</Link></li>
        ))}
      </ul>
    </nav>
  );
}

function List({ title, page, cursor, href, children }: {
  title: string;
  page: PageInfo;
  cursor: string | undefined;
  href: (cursor?: string) => string;
  children: ReactNode[];
}) {
  return (
    <>
      <h2 className={styles.sectionTitle}>{title}<span className={styles.count}>{page.totalCount}件</span></h2>
      {children.length ? <ul className={styles.list}>{children}</ul>
        : <p className={styles.text}>このページに表示できる項目はありません。</p>}
      {cursor || page.nextCursor ? (
        <nav className={styles.links} aria-label="ページ送り">
          {cursor ? <Link href={href()}>最初のページ</Link> : null}
          {page.nextCursor ? <Link href={href(page.nextCursor)}>次のページ</Link> : null}
        </nav>
      ) : null}
    </>
  );
}

async function loadList(params: ScreenSearchParams, view: View, viewer: Viewer) {
  try {
    if (params.view !== undefined && params.view !== "publication") throw new ApiError("BAD_REQUEST");
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (Array.isArray(value)) throw new ApiError("BAD_REQUEST");
      if (name !== "view" && value !== undefined) query.set(name, value);
    }
    const url = new URL(`http://app${listPath}?${query}`);
    if (view === "publication") {
      const input = parseAdminNoticeQuery(url);
      const { data, page } = await readForScreen((db) => listAdminNotices(db, viewer, input));
      return { kind: "publication", input, items: data.items, page } as const;
    }
    const input = parseAdminNoticeRequestQuery(url);
    const { data, page } = await readForScreen((db) => listAdminNoticeRequests(db, viewer, input));
    return { kind: "review", input, items: data.items, page } as const;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { kind: "invalid", message: error.code === "INVALID_CURSOR" ? "一覧の続きを表示できませんでした。"
      : error.code === "FORBIDDEN" ? "この公開状態の一覧を表示する権限がありません。"
        : "一覧の条件を確認してください。" } as const;
  }
}

export default async function AdminNoticesPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const params = await searchParams;
  const { viewer, shell, access } = await requireAdminScreen("any", listPath, params);
  if (access === "denied") return <AppShell viewer={shell}><AdminAccessDenied /></AppShell>;

  const view = params.view === "publication" ? "publication" : "review";
  const result = await loadList(params, view, viewer);
  let content: ReactNode;
  if (result.kind === "publication") {
    const { input, page, items } = result;
    const states = viewer.roles.schoolManager ? ["all", "public", "hidden", "deleted"] as const
      : ["all", "public", "hidden"] as const;
    content = (
      <>
        <Filters label="公開状態" values={states} current={input.state} labels={{ all: "すべて", ...publicationLabels }}
          href={(state) => listHref({ view, state })} />
        <List title="公開管理一覧" page={page} cursor={input.cursor}
          href={(cursor) => listHref({ view, state: input.state, ...(cursor ? { cursor } : {}) })}>
          {items.map((notice) => (
            <li className={styles.listItem} key={notice.id}>
              <span className={publicationBadge[notice.publicationState]}>{publicationLabels[notice.publicationState]}</span>
              <Link className={styles.itemLink} href={`${listPath}/${notice.id}`}>{notice.title}</Link>
              <span className={styles.meta}>{originLabels[notice.originKind]}</span>
            </li>
          ))}
        </List>
      </>
    );
  } else if (result.kind === "review") {
    const { input, page, items } = result;
    content = (
      <>
        <Filters label="審査状況" values={["pending", "approved", "rejected"] as const}
          current={input.status} labels={reviewLabels} href={(status) => listHref({ status, kind: input.kind })} />
        <Filters label="申請種別" values={["all", "new", "edit"] as const} current={input.kind}
          labels={{ all: "すべて", ...requestKindLabels }} href={(kind) => listHref({ status: input.status, kind })} />
        <List title="審査一覧" page={page} cursor={input.cursor}
          href={(cursor) => listHref({ status: input.status, kind: input.kind, ...(cursor ? { cursor } : {}) })}>
          {items.map(({ request, title }) => (
            <li className={styles.listItem} key={request.id}>
              <span className={reviewBadge[request.status]}>{reviewLabels[request.status]}</span>
              <Link className={styles.itemLink} href={`${listPath}/${request.resourceId}?request=${request.id}`}>{title}</Link>
              <span className={styles.meta}>{requestKindLabels[request.kind]} · {formatDateTime(request.submittedAt)}
                {request.status === "pending" && !request.canReview ? " · 審査不可" : ""}</span>
            </li>
          ))}
        </List>
      </>
    );
  } else {
    content = (
      <div className={styles.formError} role="alert">
        <p>{result.message}</p>
        <Link href={view === "publication" ? listHref({ view }) : listPath}>最初のページを表示する</Link>
      </div>
    );
  }

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <h1 className={styles.title}>お知らせの審査・公開管理</h1>
        <Filters label="管理メニュー" values={["review", "publication"] as const} current={view}
          labels={{ review: "申請審査", publication: "公開管理" }}
          href={(value) => value === "review" ? listPath : listHref({ view: value })} />
        <section className={styles.card} aria-label={view === "publication" ? "公開管理" : "申請審査"}>{content}</section>
      </div>
    </AppShell>
  );
}
