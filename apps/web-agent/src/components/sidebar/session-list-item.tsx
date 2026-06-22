"use client";

import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@meshbot/design";
import type { SessionSummary } from "@meshbot/types-agent";
import { useAtomValue, useSetAtom } from "jotai";
import { MoreHorizontal, Pencil, Sparkles, Trash2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type KeyboardEvent, useCallback, useRef, useState } from "react";
import {
  clearScheduleActivityAtom,
  scheduleActivityAtom,
} from "@/atoms/schedule-activity";
import { deleteSessionAtom, renameSessionAtom } from "@/atoms/sessions";
import { SessionDeleteDialog } from "./session-delete-dialog";

/**
 * 单条会话。三态：
 *  - 默认：图标 + 标题 + 三点（hover 显）
 *  - 编辑：图标 + Input（autofocus + 全选）；Enter/blur 保存、Esc 取消、IME 期 Enter 忽略
 *  - 激活：路由匹配则高亮（半透明白选中）
 *
 * 三点菜单：修改标题 / 固定·取消固定 / 删除 —— 使用 shadcn DropdownMenu。
 */
export function SessionListItem({ session }: { session: SessionSummary }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("appShell.sessionMenu");
  const scheduleActivity = useAtomValue(scheduleActivityAtom);
  const clearScheduleActivity = useSetAtom(clearScheduleActivityAtom);
  const hasActivity = scheduleActivity.has(session.id);
  const rename = useSetAtom(renameSessionAtom);
  const removeSession = useSetAtom(deleteSessionAtom);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 会话页路由已合并到 /messages?kind=assistant&id=<sid>
  const active =
    pathname === "/messages" &&
    searchParams.get("id") === session.id &&
    searchParams.get("kind") === "assistant";

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
          "group flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] transition-colors",
          active
            ? "bg-(--shell-accent) text-white"
            : "text-white/85 hover:bg-white/12 hover:text-white",
        )}
      >
        <Sparkles
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            active ? "text-white" : "text-white/70 group-hover:text-white",
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
            onClick={() => {
              clearScheduleActivity(session.id);
              router.push(`/messages?kind=assistant&id=${session.id}`);
            }}
            className="min-w-0 flex-1 truncate text-left"
            title={session.title}
          >
            {session.title}
          </button>
        )}
        {hasActivity && !active && !editing && (
          <span
            className="mr-1 h-1.5 w-1.5 shrink-0 rounded-full bg-(--shell-accent)"
            aria-hidden
          />
        )}
        {!editing && (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "opacity-0 transition-opacity group-hover:opacity-100",
                  menuOpen && "opacity-100",
                  "text-white/70 hover:text-white",
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
              <DropdownMenuItem onSelect={() => startEditing()}>
                <Pencil className="h-3.5 w-3.5" />
                {t("rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                destructive
                onSelect={() => setConfirmOpen(true)}
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
