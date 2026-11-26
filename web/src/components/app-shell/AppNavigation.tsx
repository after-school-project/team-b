"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { requestSignOut, signOutError } from "@/auth/sign-out";
import {
  ACCOUNT_NAV_ITEMS,
  ADMIN_NAV_ITEM,
  NOTIFICATION_NAV_ITEM,
  PRIMARY_NAV_ITEMS,
  formatUnreadCount,
  getAriaCurrent,
  isNavItemAvailable,
  type AppShellViewer,
  type NavItem,
} from "./navigation";
import styles from "./AppShell.module.css";

type AppNavigationProps = {
  viewer: AppShellViewer;
  unreadNotificationCount?: number;
};

/**
 * 進行中のログアウト要求。AppShell は画面ごとに描画され、画面移動で AppNavigation が作り直されるため、
 * 二重送信の防止をモジュール単位で持つ。成功時は残したままにし、ログイン画面へ移動する。
 */
let pendingSignOut: Promise<boolean> | null = null;

function startSignOut(): Promise<boolean> {
  pendingSignOut ??= requestSignOut().then((signedOut) => {
    if (signedOut) window.location.replace("/login");
    else pendingSignOut = null;
    return signedOut;
  });
  return pendingSignOut;
}

export function AppNavigation({ viewer, unreadNotificationCount }: AppNavigationProps) {
  const pathname = usePathname() ?? "/";
  const idPrefix = useId();
  const menuId = `${idPrefix}-menu`;
  const accountMenuId = `${idPrefix}-account`;

  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  // 画面移動で作り直された場合も、進行中のログアウトを処理中として表示する。
  const [loggingOut, setLoggingOut] = useState(() => pendingSignOut !== null);
  const [logoutMessage, setLogoutMessage] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  // 閉じたメニューに前回のログアウト失敗を残さない。
  const closeAccountMenu = () => {
    if (!accountOpen) return;
    setAccountOpen(false);
    setLogoutMessage(null);
  };
  const closeMainMenu = () => {
    if (!menuOpen) return;
    setMenuOpen(false);
    setLogoutMessage(null);
  };

  useDismissOnOutsideClick(accountRef, accountOpen, closeAccountMenu);

  // 前の画面で始めたログアウトが失敗した場合も、エラーを表示して再試行できるようにする。
  useEffect(() => {
    const request = pendingSignOut;
    if (!request) return;
    let active = true;
    void request.then((signedOut) => {
      if (!active || signedOut) return;
      setLoggingOut(false);
      setLogoutMessage(signOutError);
    });
    return () => {
      active = false;
    };
  }, []);

  // ログアウト後に「戻る」でキャッシュから復元された場合は、サーバーで認可し直す（未ログインならログイン画面へ移動する）。
  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      if (pendingSignOut) {
        window.location.reload();
        return;
      }
      fetch("/api/v1/me", { cache: "no-store" })
        .then((response) => {
          if (response.status === 401) window.location.reload();
        })
        .catch(() => {});
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  async function signOut() {
    // 送信中もボタンのフォーカスを維持し、再送はここで防ぐ。
    if (pendingSignOut) return;
    setLoggingOut(true);
    setLogoutMessage(null);
    if (await startSignOut()) return;
    setLoggingOut(false);
    setLogoutMessage(signOutError);
  }

  const unreadLabel = formatUnreadCount(unreadNotificationCount);
  // 未読件数は渡された場合だけ表示する。通知画面の実装状況（導線を押せるか）とは独立させる。
  const unreadBadge = unreadLabel ? (
    <span className={styles.badge}>
      <span aria-hidden="true">{unreadLabel}</span>
      <span className={styles.visuallyHidden}>（未読{unreadLabel}件）</span>
    </span>
  ) : null;
  const closeAll = () => {
    closeMainMenu();
    closeAccountMenu();
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && menuOpen) {
      event.stopPropagation();
      closeMainMenu();
      menuButtonRef.current?.focus();
    }
  };

  const handleAccountKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && accountOpen) {
      event.stopPropagation();
      closeAccountMenu();
      accountButtonRef.current?.focus();
    }
  };

  return (
    <>
      <div className={styles.utilities}>
        {isNavItemAvailable(NOTIFICATION_NAV_ITEM) ? (
          <Link
            className={styles.utilityLink}
            href={NOTIFICATION_NAV_ITEM.href}
            aria-current={getAriaCurrent(pathname, NOTIFICATION_NAV_ITEM.href)}
            onClick={closeAll}
          >
            <span>{NOTIFICATION_NAV_ITEM.label}</span>
            {unreadBadge}
          </Link>
        ) : (
          <UnavailableItem className={styles.utilityUnavailable} label={NOTIFICATION_NAV_ITEM.label}>
            {unreadBadge}
          </UnavailableItem>
        )}

        <div
          className={styles.accountMenu}
          ref={accountRef}
          onKeyDown={handleAccountKeyDown}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              closeAccountMenu();
            }
          }}
        >
          <button
            ref={accountButtonRef}
            type="button"
            className={styles.utilityButton}
            aria-expanded={accountOpen}
            aria-controls={accountMenuId}
            onClick={() => {
              if (accountOpen) closeAccountMenu();
              else setAccountOpen(true);
              closeMainMenu();
            }}
          >
            マイメニュー
            <span className={styles.chevron} aria-hidden="true" />
          </button>
          <div id={accountMenuId} className={styles.accountPanel} hidden={!accountOpen}>
            <p className={styles.accountName}>
              <span className={styles.accountNameLabel}>ログイン中</span>
              {viewer.displayName}
            </p>
            <NavList items={ACCOUNT_NAV_ITEMS} pathname={pathname} onNavigate={closeAll} />
            <SignOutControl
              busy={loggingOut}
              error={logoutMessage}
              onSignOut={signOut}
            />
          </div>
        </div>

        <button
          ref={menuButtonRef}
          type="button"
          className={`${styles.utilityButton} ${styles.menuButton}`}
          aria-expanded={menuOpen}
          aria-controls={menuId}
          onClick={() => {
            if (menuOpen) closeMainMenu();
            else setMenuOpen(true);
            closeAccountMenu();
          }}
        >
          {menuOpen ? "閉じる" : "メニュー"}
        </button>
      </div>

      <div
        id={menuId}
        className={styles.menuPanel}
        data-open={menuOpen ? "true" : "false"}
        onKeyDown={handleMenuKeyDown}
      >
        <nav className={styles.primaryNav} aria-label="主要メニュー">
          <NavList items={PRIMARY_NAV_ITEMS} pathname={pathname} onNavigate={closeAll} />
        </nav>

        <nav className={styles.mobileAccountNav} aria-label="マイメニュー">
          <p className={styles.accountName}>
            <span className={styles.accountNameLabel}>ログイン中</span>
            {viewer.displayName}
          </p>
          <NavList items={ACCOUNT_NAV_ITEMS} pathname={pathname} onNavigate={closeAll} />
          <SignOutControl
            busy={loggingOut}
            error={logoutMessage}
            onSignOut={signOut}
          />
        </nav>

        {!viewer.canAccessAdmin ? null : isNavItemAvailable(ADMIN_NAV_ITEM) ? (
          <Link
            className={styles.adminLink}
            href={ADMIN_NAV_ITEM.href}
            aria-current={getAriaCurrent(pathname, ADMIN_NAV_ITEM.href)}
            onClick={closeAll}
          >
            {ADMIN_NAV_ITEM.label}
          </Link>
        ) : (
          <UnavailableItem className={styles.adminUnavailable} label={ADMIN_NAV_ITEM.label} />
        )}
      </div>
    </>
  );
}

function SignOutControl({
  busy, error, onSignOut,
}: {
  busy: boolean;
  error: string | null;
  onSignOut: () => void;
}) {
  return (
    <div className={styles.signOutControl}>
      {error ? <p className={styles.signOutError} role="alert">{error}</p> : null}
      <button
        className={styles.signOutButton}
        type="button"
        onClick={() => void onSignOut()}
        aria-disabled={busy}
      >
        {busy ? "ログアウト中..." : "ログアウト"}
      </button>
    </div>
  );
}

function NavList({
  items,
  pathname,
  onNavigate,
}: {
  items: readonly NavItem[];
  pathname: string;
  onNavigate: () => void;
}) {
  return (
    <ul className={styles.navList}>
      {items.map((item) => (
        <li key={item.href}>
          {isNavItemAvailable(item) ? (
            <Link
              className={styles.navLink}
              href={item.href}
              aria-current={getAriaCurrent(pathname, item.href)}
              onClick={onNavigate}
            >
              {item.label}
            </Link>
          ) : (
            <UnavailableItem className={styles.navUnavailable} label={item.label} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** 未実装の画面への導線。リンクにせず（フォーカスも受けない）、準備中であることを表示と読み上げの両方で伝える。 */
function UnavailableItem({ className, label, children }: { className: string; label: string; children?: ReactNode }) {
  return (
    <span className={className}>
      {label}
      {children}
      <span className={styles.soonLabel}>
        <span className={styles.visuallyHidden}>（</span>準備中<span className={styles.visuallyHidden}>）</span>
      </span>
    </span>
  );
}

function useDismissOnOutsideClick(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onDismiss: () => void,
) {
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (!active) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) {
        onDismissRef.current();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [active, ref]);
}
