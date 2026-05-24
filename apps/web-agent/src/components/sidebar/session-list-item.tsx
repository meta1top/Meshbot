"use client";

import { cn } from "@meshbot/design";
import type { SessionSummary } from "@meshbot/types-agent";
import { useSetAtom } from "jotai";
import {
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type KeyboardEvent, useCallback, useRef, useState } from "react";
import {
  deleteSessionAtom,
  renameSessionAtom,
  togglePinAtom,
} from "@/atoms/sessions";
import { SessionDeleteDialog } from "./session-delete-dialog";

/**
 * 单条会话。三态：
 *  - 默认：图标 + 标题 + 三点（hover 显）
 *  - 编辑：图标 + Input（autofocus + 全选）；Enter/blur 保存、Esc 取消、IME 期 Enter 忽略
 *  - 激活：路由匹配则高亮（与 SidebarNavItem 一致色）
 *
 * 三点菜单：修改标题 / 固定·取消固定 / 删除。
 */
export function SessionListItem({ session }: { session: SessionSummary }) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("appShell.sessionMenu");
  const rename = useSetAtom(renameSessionAtom);
  const togglePin = useSetAtom(togglePinAtom);
  const removeSession = useSetAtom(deleteSessionAtom);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const active = pathname === `/session/${session.id}`;

  const startEditing = useCallback(() => {
    setMenuOpen(false);
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const submitTitle = useCallback(
    async (value: string) => {
      setEditing(false);
      try {
        await rename({ id: session.id, title: value });
      } catch {
        // atom 内已回滚
      }
    },
    [rename, session.id],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (
        e.key === "Enter" &&
        !e.nativeEvent.isComposing &&
        e.keyCode !== 229
      ) {
        e.preventDefault();
        submitTitle((e.target as HTMLInputElement).value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditing(false);
      }
    },
    [submitTitle],
  );

  const handleDeleteConfirm = useCallback(async () => {
    setConfirmOpen(false);
    try {
      await removeSession(session.id);
      if (active) router.push("/");
    } catch {
      // atom 内已回滚
    }
  }, [removeSession, session.id, active, router]);

  return (
    <>
      <div
        className={cn(
          "group flex items-center gap-2 rounded-none px-2 py-1.5 text-[14px]",
          active
            ? "bg-accent text-white"
            : "text-foreground/80 hover:bg-accent hover:text-white",
        )}
      >
        <MessageSquare
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            active
              ? "text-white"
              : "text-muted-foreground group-hover:text-white",
          )}
        />
        {editing ? (
          <input
            ref={inputRef}
            defaultValue={session.title}
            onKeyDown={handleKeyDown}
            onBlur={(e) => submitTitle(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-inherit outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => router.push(`/session/${session.id}`)}
            className="min-w-0 flex-1 truncate text-left"
            title={session.title}
          >
            {session.title}
          </button>
        )}
        {!editing && (
          <div className="relative">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className={cn(
                "opacity-0 transition-opacity group-hover:opacity-100",
                menuOpen && "opacity-100",
              )}
              aria-label="menu"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <div
                role="menu"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                className="absolute right-0 top-5 z-10 min-w-[120px] border border-border bg-popover text-popover-foreground shadow"
              >
                <MenuItem
                  icon={<Pencil className="h-3 w-3" />}
                  onClick={startEditing}
                >
                  {t("rename")}
                </MenuItem>
                <MenuItem
                  icon={
                    session.pinned ? (
                      <PinOff className="h-3 w-3" />
                    ) : (
                      <Pin className="h-3 w-3" />
                    )
                  }
                  onClick={async () => {
                    setMenuOpen(false);
                    try {
                      await togglePin({
                        id: session.id,
                        pinned: !session.pinned,
                      });
                    } catch {
                      // 已回滚
                    }
                  }}
                >
                  {session.pinned ? t("unpin") : t("pin")}
                </MenuItem>
                <MenuItem
                  icon={<Trash2 className="h-3 w-3" />}
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmOpen(true);
                  }}
                  destructive
                >
                  {t("delete")}
                </MenuItem>
              </div>
            )}
          </div>
        )}
      </div>
      <SessionDeleteDialog
        open={confirmOpen}
        title={session.title}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}

function MenuItem({
  icon,
  children,
  onClick,
  destructive,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent hover:text-white",
        destructive && "text-destructive",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
