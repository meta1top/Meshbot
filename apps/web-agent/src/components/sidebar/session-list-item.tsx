"use client";

import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@meshbot/design";
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
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
 * 三点菜单：修改标题 / 固定·取消固定 / 删除 —— 使用 shadcn DropdownMenu。
 */
export function SessionListItem({ session }: { session: SessionSummary }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("appShell.sessionMenu");
  const rename = useSetAtom(renameSessionAtom);
  const togglePin = useSetAtom(togglePinAtom);
  const removeSession = useSetAtom(deleteSessionAtom);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 会话页路由是 /session?id=<sid>（query string），不是 /session/<sid>
  const active =
    pathname === "/session" && searchParams.get("id") === session.id;

  const startEditing = useCallback(() => {
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
    setDeleting(true);
    try {
      await removeSession(session.id);
      // 成功才关 dialog；失败留着让用户看到状态（atom 内已回滚列表，dialog
      // 显示「请重试或取消」由用户决定）。
      setConfirmOpen(false);
      if (active) router.push("/");
    } catch {
      // atom 内已回滚
    } finally {
      setDeleting(false);
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
            onClick={() => router.push(`/session?id=${session.id}`)}
            className="min-w-0 flex-1 truncate text-left"
            title={session.title}
          >
            {session.title}
          </button>
        )}
        {!editing && (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "opacity-0 transition-opacity group-hover:opacity-100",
                  menuOpen && "opacity-100",
                )}
                aria-label="menu"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={4}
              className="min-w-[140px]"
            >
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  startEditing();
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
                {t("rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={async (e) => {
                  e.preventDefault();
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
                {session.pinned ? (
                  <PinOff className="h-3.5 w-3.5" />
                ) : (
                  <Pin className="h-3.5 w-3.5" />
                )}
                {session.pinned ? t("unpin") : t("pin")}
              </DropdownMenuItem>
              <DropdownMenuItem
                destructive
                onSelect={(e) => {
                  e.preventDefault();
                  setConfirmOpen(true);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <SessionDeleteDialog
        open={confirmOpen}
        title={session.title}
        loading={deleting}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}
