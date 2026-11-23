"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
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

export function AppNavigation({ viewer, unreadNotificationCount }: AppNavigationProps) {
  const pathname = usePathname() ?? "/";
  const idPrefix = useId();
  const menuId = `${idPrefix}-menu`;
  const accountMenuId = `${idPrefix}-account`;

  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  useDismissOnOutsideClick(accountRef, accountOpen, () => setAccountOpen(false));

  const unreadLabel = formatUnreadCount(unreadNotificationCount);
  const closeAll = () => {
    setMenuOpen(false);
    setAccountOpen(false);
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && menuOpen) {
      event.stopPropagation();
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    }
  };

  const handleAccountKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && accountOpen) {
      event.stopPropagation();
      setAccountOpen(false);
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
            {unreadLabel ? (
              <span className={styles.badge}>
                <span aria-hidden="true">{unreadLabel}</span>
                <span className={styles.visuallyHidden}>（未読{unreadLabel}件）</span>
              </span>
            ) : null}
          </Link>
        ) : (
          <UnavailableItem className={styles.utilityUnavailable} label={NOTIFICATION_NAV_ITEM.label} />
        )}

        <div
          className={styles.accountMenu}
          ref={accountRef}
          onKeyDown={handleAccountKeyDown}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setAccountOpen(false);
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
              setAccountOpen((open) => !open);
              setMenuOpen(false);
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
          </div>
        </div>

        <button
          ref={menuButtonRef}
          type="button"
          className={`${styles.utilityButton} ${styles.menuButton}`}
          aria-expanded={menuOpen}
          aria-controls={menuId}
          onClick={() => {
            setMenuOpen((open) => !open);
            setAccountOpen(false);
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
function UnavailableItem({ className, label }: { className: string; label: string }) {
  return (
    <span className={className}>
      {label}
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
