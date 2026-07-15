"use client";

import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@meshbot/design";
import {
  Loader2,
  MoreHorizontal,
  Pencil,
  Sparkles,
  SquarePen,
  Trash2,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type NavGroup,
  type NavNode,
  SidebarNav,
  SidebarRow,
  type SidebarRowProps,
  SidebarSkeleton,
} from "../shell";

export type { NavGroup, NavNode } from "../shell";

/**
 * 设备→会话树的文案注入（i18n 全部由调用方经此传入，本组件不碰 next-intl）。
 */
export interface SessionTreeLabels {
  /** 设备离线徽标。 */
  offline: string;
  /**
   * 会话三点菜单 / 删除确认框文案。全部只读时（所有会话节点 `editable`/
   * `deletable` 皆为假，如 web-main 纯远程场景，wire protocol 无 rename/delete
   * 能力）不会被渲染到，可省略。
   */
  rename?: string;
  delete?: string;
  deleteConfirmTitle?: (title: string) => ReactNode;
  deleteConfirmDescription?: ReactNode;
  deleteConfirmConfirm?: string;
  deleteConfirmCancel?: string;
  /** 设备行内「新建会话」按钮 title（仅 onNewSession 注入时使用）。 */
  newSession?: string;
  /** Agent 行编辑按钮 aria-label / title（仅 onEditAgent 注入时使用）。 */
  editAgent?: string;
}

/**
 * 按 `NavNode.key` 还原的渲染元数据。树的结构（谁是谁的子节点/chevron/展开态）
 * 交给 `NavGroup`/`NavNode` + `SidebarNav` 通用机制；这里只还原「怎么画这一行」
 * 所需的业务语义 —— 与 web-agent 迁移前 `AssistantSidebar` 内的 `metaByKey` 同构，
 * 差别是由调用方以纯函数形式注入，而不是 SessionTree 自己攒 Map（避免这个共享
 * 组件反过来依赖调用方的数据源）。
 */
export type SessionTreeNodeInfo =
  | {
      kind: "device";
      /** 在线态：决定 chevron 是否可点、offline 徽标是否显示。 */
      online: boolean;
      /** 是否可展开（离线设备 hasChildren 仍可为 true 以撑出 chevron，
       *  但点击/展开态由 expandable 挡住 —— 对齐 web-agent「离线也显示 chevron，
       *  置灰不可点」的既有交互）。 */
      expandable: boolean;
    }
  | {
      kind: "session";
      title: string;
      /** 支持内联改名（远程只读会话不传/传 false）。 */
      editable?: boolean;
      /** 支持删除（远程只读会话不传/传 false）。 */
      deletable?: boolean;
      /** 活动小红点（如「定时任务刚触发」未查看）。 */
      hasActivity?: boolean;
    }
  | {
      kind: "placeholder";
      /** skeleton：一段脉冲占位；note：纯文字提示（骨架/空态/加载失败）。 */
      variant: "skeleton" | "note";
    }
  | {
      kind: "agent";
      /** 头像 emoji（web-agent 侧已从「emoji|色值」拆好，本组件只管渲染）。 */
      emoji: string;
      /** 头像背景色（#hex）。 */
      color: string;
      name: string;
      /** 该 Agent 名下有会话在跑 → 显示脉冲点。 */
      running: boolean;
    };

export interface SessionTreeProps {
  groups: NavGroup[];
  /** 当前激活会话对应的 `NavNode.key`；用于高亮 + 驱动祖先设备分支自动展开
   *（`SidebarNav` 内建：`node.defaultOpen ?? isNavNodeActive(node, activeKey)`）。 */
  activeSessionKey?: string;
  /** 顶层加载态（设备列表本身未到达前）；命中时整树替换为骨架。 */
  loading?: boolean;
  /** 按 key 解析节点类型 + 渲染所需的富数据；返回 undefined 按普通行兜底渲染。 */
  nodeInfo: (node: NavNode) => SessionTreeNodeInfo | undefined;
  /** 设备节点展开（用户点开，非 defaultOpen 触发）：懒加载该设备会话列表。 */
  onExpandDevice?: (node: NavNode) => void;
  /** 设备行内「新建会话」按钮点击（不传则该按钮不出现，如 web-agent 用全局
   *  头部「+」代替，不需要逐设备入口）。 */
  onNewSession?: (node: NavNode) => void;
  /** 改名提交；抛错时内联输入已关闭、调用方需自行处理回滚（乐观更新失败）。 */
  onRenameSession?: (node: NavNode, title: string) => Promise<void> | void;
  /** 删除确认；成功后关闭确认框，失败时确认框留着、按钮恢复可点供重试/取消。 */
  onDeleteSession?: (node: NavNode) => Promise<void> | void;
  /** Agent 行编辑按钮点击（不传则该按钮不出现）。 */
  onEditAgent?: (node: NavNode) => void;
  labels: SessionTreeLabels;
}

/**
 * 设备 → 会话两级展开树。纯数据/回调注入 —— 不碰 jotai / next-intl / apiClient /
 * next/navigation，两端（web-agent 本地 + web-main 纯远程）复用同一份渲染 +
 * 交互逻辑（chevron、在线点、改名内联编辑、删除确认、活动小红点、自动展开高亮）。
 *
 * 树的骨架（分组/节点/chevron/展开态/自动展开）委托给 `SidebarNav`；本组件只提供
 * `renderRow`，按 `nodeInfo(node)` 的判别结果分派到设备行 / 会话行 / 占位行。
 */
export function SessionTree({
  groups,
  activeSessionKey,
  loading,
  nodeInfo,
  onExpandDevice,
  onNewSession,
  onRenameSession,
  onDeleteSession,
  onEditAgent,
  labels,
}: SessionTreeProps) {
  const renderRow = (node: NavNode, defaults: SidebarRowProps): ReactNode => {
    const info = nodeInfo(node);
    if (!info) return <SidebarRow {...defaults} />;
    switch (info.kind) {
      case "device":
        return (
          <DeviceRow
            node={node}
            defaults={defaults}
            info={info}
            onNewSession={onNewSession}
            labels={labels}
          />
        );
      case "session":
        return (
          <SessionRow
            node={node}
            active={!!defaults.active}
            depth={defaults.depth ?? 0}
            info={info}
            onRenameSession={onRenameSession}
            onDeleteSession={onDeleteSession}
            labels={labels}
          />
        );
      case "placeholder":
        return info.variant === "skeleton" ? (
          <SidebarSkeleton />
        ) : (
          <div
            className="py-1 pr-2 text-[12px] text-(--shell-sidebar-fg)/55"
            style={{ paddingLeft: `${8 + (defaults.depth ?? 0) * 14}px` }}
          >
            {node.label}
          </div>
        );
      case "agent":
        return (
          <AgentRow
            node={node}
            defaults={defaults}
            info={info}
            onEditAgent={onEditAgent}
            labels={labels}
          />
        );
    }
  };

  return (
    <SidebarNav
      loading={loading}
      groups={groups}
      activeKey={activeSessionKey}
      onExpand={onExpandDevice}
      renderRow={renderRow}
    />
  );
}

/** 设备行：chevron（SidebarNav 已在 defaults.icon 给出）+ 在线点 + 离线置灰。 */
function DeviceRow({
  node,
  defaults,
  info,
  onNewSession,
  labels,
}: {
  node: NavNode;
  defaults: SidebarRowProps;
  info: Extract<SessionTreeNodeInfo, { kind: "device" }>;
  onNewSession?: (node: NavNode) => void;
  labels: SessionTreeLabels;
}) {
  const row = (
    <SidebarRow
      icon={
        <>
          {defaults.icon}
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              info.online ? "bg-[#16a34a]" : "bg-(--shell-sidebar-fg)/30",
            )}
          />
        </>
      }
      label={
        <span className="font-semibold text-(--shell-sidebar-fg)">
          {node.label}
        </span>
      }
      depth={defaults.depth}
      trailing={
        !info.online ? (
          <span className="shrink-0 text-[11px] text-(--shell-sidebar-fg)/50">
            {labels.offline}
          </span>
        ) : undefined
      }
      actions={
        info.expandable && onNewSession ? (
          <button
            type="button"
            title={labels.newSession}
            onClick={(e) => {
              e.stopPropagation();
              onNewSession(node);
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-(--shell-sidebar-fg)/60 transition-colors hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)"
          >
            <SquarePen className="h-3.5 w-3.5" />
          </button>
        ) : undefined
      }
      onClick={info.expandable ? defaults.onClick : undefined}
    />
  );
  return info.expandable ? (
    row
  ) : (
    <div className="pointer-events-none opacity-50">{row}</div>
  );
}

/** Agent 行：chevron（SidebarNav 已在 defaults.icon 给出）+ 圆形头像（色底 emoji）
 *  + 名字 + running 脉冲点 + hover 编辑（复用 SidebarRow 的 actions 出现机制，
 *  不额外造 hover 逻辑，同 DeviceRow/SessionRow 的按钮）。行本体点击只做
 *  展开/收起（`defaults.onClick` 是 NavItem 的 toggle 分支）——不再有「设为
 *  当前 Agent」的并行通道，Agent 是并列关系，没有全局当前态可切。 */
function AgentRow({
  node,
  defaults,
  info,
  onEditAgent,
  labels,
}: {
  node: NavNode;
  defaults: SidebarRowProps;
  info: Extract<SessionTreeNodeInfo, { kind: "agent" }>;
  onEditAgent?: (node: NavNode) => void;
  labels: SessionTreeLabels;
}) {
  return (
    <SidebarRow
      icon={
        <>
          {defaults.icon}
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px]"
            style={{ backgroundColor: info.color }}
          >
            {info.emoji}
          </span>
        </>
      }
      label={
        <span className="flex items-center gap-1.5 font-semibold text-(--shell-sidebar-fg)">
          {info.name}
          {info.running ? (
            <span
              className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#16a34a]"
              aria-hidden
            />
          ) : null}
        </span>
      }
      depth={defaults.depth}
      onClick={defaults.onClick}
      actions={
        onEditAgent ? (
          <button
            type="button"
            title={labels.editAgent}
            aria-label={labels.editAgent}
            onClick={(e) => {
              e.stopPropagation();
              onEditAgent(node);
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-(--shell-sidebar-fg)/60 transition-colors hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        ) : undefined
      }
    />
  );
}

/**
 * 会话叶子行。三态：
 *  - 默认：组合 SidebarRow（图标 + 标题 + hover 三点 + 选中态 + 活动小红点）；
 *  - 编辑：不套 SidebarRow，原样渲染图标 + Input 行（autofocus + 全选），
 *    Enter/blur 保存、Esc 取消、IME 期 Enter 忽略；
 *  - 三点菜单仅在 `editable`/`deletable` 至少一项为真时出现（远程只读会话
 *    两者皆无 → 无菜单、无删除确认框，纯点击跳转）。
 */
function SessionRow({
  node,
  active,
  depth,
  info,
  onRenameSession,
  onDeleteSession,
  labels,
}: {
  node: NavNode;
  active: boolean;
  depth: number;
  info: Extract<SessionTreeNodeInfo, { kind: "session" }>;
  onRenameSession?: (node: NavNode, title: string) => Promise<void> | void;
  onDeleteSession?: (node: NavNode) => Promise<void> | void;
  labels: SessionTreeLabels;
}) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
        await onRenameSession?.(node, value);
      } catch {
        // 调用方负责乐观回滚（如 web-agent renameSessionAtom）
      }
    },
    [onRenameSession, node],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (
        e.key === "Enter" &&
        !e.nativeEvent.isComposing &&
        e.keyCode !== 229
      ) {
        e.preventDefault();
        void submitTitle((e.target as HTMLInputElement).value);
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
      await onDeleteSession?.(node);
      // 成功才关 dialog；失败留着让用户看到状态，由用户决定重试或取消。
      setConfirmOpen(false);
    } catch {
      // 调用方负责乐观回滚
    } finally {
      setDeleting(false);
    }
  }, [onDeleteSession, node]);

  const showMenu = !!(info.editable || info.deletable);

  return (
    <>
      {editing ? (
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
            defaultValue={info.title}
            onKeyDown={handleKeyDown}
            onBlur={(e) => void submitTitle(e.target.value)}
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
          label={<span title={info.title}>{info.title}</span>}
          active={active}
          depth={depth}
          onClick={node.onClick}
          trailing={
            info.hasActivity &&
            !active && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--shell-accent)"
                aria-hidden
              />
            )
          }
          actions={
            showMenu ? (
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-5 w-5 items-center justify-center rounded text-(--shell-sidebar-fg)/70 hover:text-(--shell-sidebar-fg)"
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
                  {info.editable && (
                    <DropdownMenuItem onSelect={() => startEditing()}>
                      <Pencil className="h-3.5 w-3.5" />
                      {labels.rename}
                    </DropdownMenuItem>
                  )}
                  {info.deletable && (
                    <DropdownMenuItem
                      destructive
                      onSelect={() => setConfirmOpen(true)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {labels.delete}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : undefined
          }
        />
      )}
      {info.deletable && (
        <TreeConfirmDialog
          open={confirmOpen}
          title={labels.deleteConfirmTitle?.(info.title)}
          description={labels.deleteConfirmDescription}
          confirmText={labels.deleteConfirmConfirm ?? ""}
          cancelText={labels.deleteConfirmCancel ?? ""}
          loading={deleting}
          destructive
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void handleDeleteConfirm()}
        />
      )}
    </>
  );
}

interface TreeConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmText: string;
  cancelText: string;
  loading?: boolean;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 删除确认框，移植自 `apps/web-agent/src/components/common/confirm-dialog.tsx`
 * （与 web-main 本地同名组件同构）。零 jotai/next-intl 依赖，内嵌本组件而非
 * 提到 `@meshbot/design`——两端各自的 `ConfirmDialog` 承担更多本地场景（如
 * web-main 版还有 `error` 展示位），保留独立、这里只拿会话删除用得到的子集。
 *
 * 用 createPortal 到 document.body：避免在带 transform 的祖先（响应式侧栏）内
 * 被 `fixed` 定位裁剪。Esc 关闭（loading 时禁用），遮罩点击不关闭（避免下拉菜单
 * 关闭时 focus 恢复触发的误触）。
 */
function TreeConfirmDialog({
  open,
  title,
  description,
  confirmText,
  cancelText,
  loading,
  destructive,
  onConfirm,
  onCancel,
}: TreeConfirmDialogProps) {
  useEffect(() => {
    if (!open || loading) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loading, onCancel]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        className="flex w-full max-w-[400px] flex-col gap-3 rounded-lg border border-border bg-background p-5 shadow-xl"
      >
        <div className="text-[15px] font-semibold text-foreground">{title}</div>
        {description && (
          <div className="text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </div>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={loading}
          >
            {cancelText}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            size="sm"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {confirmText}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
