"use client";

import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@meshbot/design";
import type { SessionSummary } from "@meshbot/types-agent";
import { SidebarRow } from "@meshbot/web-common/shell";
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
import { ConfirmDialog } from "@/components/common/confirm-dialog";

/**
 * 单条会话。三态：
 *  - 默认：组合共享 SidebarRow（图标 + 标题 + 三点 hover 显 + 选中态），
 *    与其它侧栏行统一 h-7/间距/高亮 class
 *  - 编辑：不套 SidebarRow，原样渲染图标 + Input 行（autofocus + 全选）；
 *    Enter/blur 保存、Esc 取消、IME 期 Enter 忽略
 *  - 激活：路由匹配则高亮（SidebarRow 统一的选中态背景）
 *
 * 三点菜单：修改标题 / 固定·取消固定 / 删除 —— 使用 shadcn DropdownMenu，
 * 触发按钮放进 SidebarRow 的 actions 插槽（hover 显示由 SidebarRow 统一负责）。
 */
export function SessionListItem({
  session,
  depth = 0,
}: {
  session: SessionSummary;
  depth?: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("appShell.sessionMenu");
  const tDelete = useTranslations("appShell.deleteConfirm");
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
  // 会话页路由独立在 /assistant?id=<sid>
  const active =
    pathname === "/assistant" && searchParams.get("id") === session.id;

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
      if (active) router.push("/assistant");
    } catch {
      // atom 内已回滚
    } finally {
      setDeleting(false);
    }
  }, [removeSession, session.id, active, router]);

  const handleNavigate = useCallback(() => {
    clearScheduleActivity(session.id);
    router.push(`/assistant?id=${session.id}`);
  }, [clearScheduleActivity, router, session.id]);

  return (
    <>
      {editing ? (
        // 改名态：不套 SidebarRow，原样保留手写行（input 无法塞进 SidebarRow
        // 的 <button> 主体），与迁移前逻辑/class 完全一致
        <div
          className={cn(
            "group flex h-7 w-full items-center gap-2 rounded-md pr-2 text-[13px] transition-colors",
            active
              ? "bg-(--shell-content) text-(--shell-sidebar-fg) shadow-sm"
              : "text-(--shell-sidebar-fg)/85 hover:bg-(--shell-sidebar-hover)",
          )}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <Sparkles
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              active
                ? "text-(--shell-accent)"
                : "text-(--shell-sidebar-fg)/60 group-hover:text-(--shell-sidebar-fg)",
            )}
          />
          <input
            ref={inputRef}
            defaultValue={session.title}
            onKeyDown={handleKeyDown}
            onBlur={(e) => submitTitle(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-inherit outline-none"
          />
        </div>
      ) : (
        <SidebarRow
          icon={
            <Sparkles
              className={cn(
                active
                  ? "text-(--shell-accent)"
                  : "text-(--shell-sidebar-fg)/60 group-hover/row:text-(--shell-sidebar-fg)",
              )}
            />
          }
          label={<span title={session.title}>{session.title}</span>}
          active={active}
          depth={depth}
          onClick={handleNavigate}
          trailing={
            hasActivity &&
            !active && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--shell-accent)"
                aria-hidden
              />
            )
          }
          actions={
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="text-(--shell-sidebar-fg)/70 hover:text-(--shell-sidebar-fg)"
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
          }
        />
      )}
      <ConfirmDialog
        open={confirmOpen}
        title={tDelete("title", { title: session.title })}
        description={tDelete("description")}
        confirmText={tDelete("confirm")}
        cancelText={tDelete("cancel")}
        loading={deleting}
        destructive
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}
