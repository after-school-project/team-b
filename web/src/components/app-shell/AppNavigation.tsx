"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { requestSignOut, signOutError } from "@/auth/sign-out";
import {
  ACCOUNT_NAV_ITEMS,
  ADMIN_NAV_ITEM,
  ADMIN_REPORTS_NAV_ITEM,
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
 * ログアウトの状態。AppShell は画面ごとに描画され、画面移動で AppNavigation が作り直されるため、モジュール単位で一つだけ持つ。
 * - pending: 要求の応答待ち。二重送信を防ぐ。
 * - signed-out: 失効を確認済み。ログイン画面へ移動する。
 * - failed: 失敗した。移動先の画面でもエラーを表示し、メニューを閉じるか再試行するまで保持する。
 */
type SignOutStatus = "idle" | "pending" | "signed-out" | "failed";

let signOutStatus: SignOutStatus = "idle";
const signOutListeners = new Set<() => void>();

function setSignOutStatus(status: SignOutStatus) {
  signOutStatus = status;
  signOutListeners.forEach((listener) => listener());
}

function subscribeSignOutStatus(listener: () => void) {
  signOutListeners.add(listener);
  return () => {
    signOutListeners.delete(listener);
  };
}

const getSignOutStatus = () => signOutStatus;
const getServerSignOutStatus = (): SignOutStatus => "idle";

function isSignOutInProgress(status: SignOutStatus) {
  return status === "pending" || status === "signed-out";
}

async function startSignOut() {
  if (isSignOutInProgress(signOutStatus)) return;
  setSignOutStatus("pending");
  if (await requestSignOut()) {
    setSignOutStatus("signed-out");
    window.location.replace("/login");
    return;
  }
  setSignOutStatus("failed");
}

/** 閉じたメニューに前回のログアウト失敗を残さない。 */
function clearSignOutFailure() {
  if (signOutStatus === "failed") setSignOutStatus("idle");
}

export function AppNavigation({ viewer, unreadNotificationCount }: AppNavigationProps) {
  const pathname = usePathname() ?? "/";
  const adminNavItem = isNavItemAvailable(ADMIN_NAV_ITEM) ? ADMIN_NAV_ITEM : ADMIN_REPORTS_NAV_ITEM;
  const idPrefix = useId();
  const menuId = `${idPrefix}-menu`;
  const accountMenuId = `${idPrefix}-account`;

  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  // 前の画面で始めたログアウトの状態も、描画から購読開始までの変化を含めて反映する。
  const status = useSyncExternalStore(subscribeSignOutStatus, getSignOutStatus, getServerSignOutStatus);
  const loggingOut = isSignOutInProgress(status);
  const logoutMessage = status === "failed" ? signOutError : null;
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  const closeAccountMenu = () => {
    if (!accountOpen) return;
    setAccountOpen(false);
    clearSignOutFailure();
  };
  const closeMainMenu = () => {
    if (!menuOpen) return;
    setMenuOpen(false);
    clearSignOutFailure();
  };

  useDismissOnOutsideClick(accountRef, accountOpen, closeAccountMenu);

  // ログアウト後に「戻る」でキャッシュから復元された場合は、サーバーで認可し直す（未ログインならログイン画面へ移動する）。
  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      if (isSignOutInProgress(signOutStatus)) {
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

  // 送信中もボタンのフォーカスを維持し、再送は startSignOut で防ぐ。
  const signOut = () => void startSignOut();

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

        {!viewer.canAccessAdmin ? null : isNavItemAvailable(adminNavItem) ? (
          <Link
            className={styles.adminLink}
            href={adminNavItem.href}
            aria-current={getAriaCurrent(pathname, adminNavItem.href)}
            onClick={closeAll}
          >
            {adminNavItem.label}
          </Link>
        ) : (
          <UnavailableItem className={styles.adminUnavailable} label={adminNavItem.label} />
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
