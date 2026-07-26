"use client";

import {
  Alert,
  AlertDescription,
  Button,
  cn,
  Input,
  Textarea,
} from "@meshbot/design";
import type { PromptFileMeta } from "@meshbot/types-agent";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import {
  deleteAgentPrompt,
  getAgentPrompt,
  listAgentPrompts,
  putAgentPrompt,
} from "@/rest/agents";

/** 人格主文件名，前端按精确匹配识别（后端已保证 list() 恒规范化为这个字面量）。 */
const MAIN_FILE = "AGENT.md";

/** 新建文件名校验：字母数字下划线点横杠 + 必须 .md 结尾，与后端 `isValidPromptFileName` 同源约束。 */
const FILE_NAME_RE = /^[\w.-]+\.md$/;

export interface PromptFilesEditorHandle {
  /** 丢弃当前选中文件的未保存改动，回退到已加载基线——供外层「切 tab 确认丢弃」后调用。 */
  discardDirty: () => void;
}

interface PromptFilesEditorProps {
  agentId: string;
  /** 冒泡「当前文件是否有未保存改动」，供外层 requestClose / tab 切换的脏检测合并判定。 */
  onDirtyChange: (dirty: boolean) => void;
}

/**
 * 提示词 tab 内容：左列文件列表（AGENT.md 置顶标「主文件」不可删）+ 右区等宽
 * textarea + 显式保存按钮——文件级即时保存，不随外层 footer。
 *
 * 未保存切换文件时本组件自己弹确认（纯内部导航，不涉及关抽屉）；未保存切 tab /
 * 关抽屉的确认由外层 `AgentEditorSheet` 统筹（通过 {@link PromptFilesEditorHandle.discardDirty}
 * 在用户确认后回收当前编辑态）。
 */
export const PromptFilesEditor = forwardRef<
  PromptFilesEditorHandle,
  PromptFilesEditorProps
>(function PromptFilesEditor({ agentId, onDirtyChange }, ref) {
  const t = useTranslations("agent.editor");

  const [files, setFiles] = useState<PromptFileMeta[] | null>(null);
  const [listLoadFailed, setListLoadFailed] = useState(false);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  // null = 本地新建、尚未成功保存过一次（任何内容都视为脏）；string = 已加载/已保存的基线。
  const [initialContent, setInitialContent] = useState<string | null>("");
  const [contentLoading, setContentLoading] = useState(false);
  const [contentLoadFailed, setContentLoadFailed] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [newFileName, setNewFileName] = useState("");
  const [newFileError, setNewFileError] = useState<string | null>(null);

  const [switchTarget, setSwitchTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const dirty = content !== initialContent;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const loadContent = async (file: string) => {
    setContentLoading(true);
    setContentLoadFailed(false);
    setSaveError(null);
    try {
      const res = await getAgentPrompt(agentId, file);
      setSelectedFile(file);
      setContent(res.content);
      setInitialContent(res.content);
    } catch {
      setContentLoadFailed(true);
    } finally {
      setContentLoading(false);
    }
  };

  // 首次挂载拉取文件列表 + 主文件正文；agentId 理论不变（同一次打开对应同一
  // Agent），但保险起见带上依赖。
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadContent 引用稳定，无需入依赖数组
  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setListLoadFailed(false);
    listAgentPrompts(agentId)
      .then((list) => {
        if (cancelled) return;
        setFiles(list);
        const first = list[0]?.file ?? MAIN_FILE;
        void loadContent(first);
      })
      .catch(() => {
        if (!cancelled) setListLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  /**
   * 丢弃当前选中文件的未保存改动：已保存过的文件回退到基线内容；从未保存过
   * 的本地新建文件没有基线可回退，直接把这个未提交的文件条目从列表移除。
   * 内部导航（切文件）与外层驱动的丢弃（切 tab / discardDirty）共用。
   */
  const discardCurrent = (): void => {
    if (initialContent !== null) {
      setContent(initialContent);
      return;
    }
    const target = selectedFile;
    setFiles((prev) => (prev ? prev.filter((f) => f.file !== target) : prev));
  };

  useImperativeHandle(ref, () => ({
    discardDirty: () => {
      const wasNewUnsaved = initialContent === null;
      const target = selectedFile;
      discardCurrent();
      if (wasNewUnsaved) {
        // 被丢弃的是从未保存过的新建文件，列表中已无它——回退选中到剩下的
        // 第一个（AGENT.md 恒在，兜底不会落空）。
        const fallback =
          (files ?? []).filter((f) => f.file !== target)[0]?.file ?? MAIN_FILE;
        void loadContent(fallback);
      }
    },
  }));

  const doSelectFile = (file: string) => {
    if (file === selectedFile) return;
    if (dirtyRef.current) {
      setSwitchTarget(file);
      return;
    }
    void loadContent(file);
  };

  const handleSave = async () => {
    if (!selectedFile) return;
    setSaving(true);
    setSaveError(null);
    try {
      await putAgentPrompt(agentId, selectedFile, content);
      setInitialContent(content);
      setFiles((prev) =>
        prev
          ? prev.map((f) =>
              f.file === selectedFile
                ? {
                    ...f,
                    size: content.length,
                    mtime: new Date().toISOString(),
                  }
                : f,
            )
          : prev,
      );
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("promptSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleCreateFile = () => {
    const name = newFileName.trim();
    if (!name) return;
    if (!FILE_NAME_RE.test(name)) {
      setNewFileError(t("promptFileNameInvalid"));
      return;
    }
    if (files?.some((f) => f.file.toLowerCase() === name.toLowerCase())) {
      setNewFileError(t("promptFileNameDuplicate"));
      return;
    }
    setNewFileError(null);
    setNewFileName("");
    setFiles((prev) => [...(prev ?? []), { file: name, size: 0, mtime: null }]);
    setSelectedFile(name);
    setContent("");
    setInitialContent(null); // 未保存过，任何内容都算脏
    setContentLoadFailed(false);
  };

  const handleDeleteConfirmed = async () => {
    const file = deleteTarget;
    if (!file) return;
    setDeleting(true);
    try {
      // 从未真正保存过的本地新建文件，服务端并无对应实体，跳过网络请求。
      const persisted = !(file === selectedFile && initialContent === null);
      if (persisted) await deleteAgentPrompt(agentId, file);
      setFiles((prev) => (prev ? prev.filter((f) => f.file !== file) : prev));
      if (file === selectedFile) {
        const remaining = (files ?? []).filter((f) => f.file !== file);
        const next = remaining[0]?.file ?? MAIN_FILE;
        void loadContent(next);
      }
      setDeleteTarget(null);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : t("promptDeleteFailed"),
      );
    } finally {
      setDeleting(false);
    }
  };

  const loading = files === null && !listLoadFailed;

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左列：文件列表 */}
      <div className="flex w-44 shrink-0 flex-col border-r border-border">
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex h-24 items-center justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : listLoadFailed ? (
            <div className="p-2 text-xs text-destructive">
              {t("promptListLoadFailed")}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {files?.map((f) => {
                const isMain = f.file === MAIN_FILE;
                const active = f.file === selectedFile;
                return (
                  <div
                    key={f.file}
                    className={cn(
                      "group flex items-center gap-1 rounded-md px-2 py-1.5 text-[12.5px]",
                      active
                        ? "bg-(--shell-accent)/12 text-foreground"
                        : "text-foreground/75 hover:bg-muted",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => doSelectFile(f.file)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      <span className="truncate">{f.file}</span>
                      {isMain && (
                        <span className="shrink-0 rounded-full bg-(--shell-accent)/15 px-1.5 py-0.5 text-[10px] font-medium text-(--shell-accent)">
                          {t("promptMainFileTag")}
                        </span>
                      )}
                    </button>
                    {!isMain && (
                      <button
                        type="button"
                        aria-label={t("promptDeleteFile")}
                        onClick={() => setDeleteTarget(f.file)}
                        className="hidden h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:flex"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部新建输入框 */}
        <div className="flex shrink-0 flex-col gap-1 border-t border-border p-2">
          <div className="flex items-center gap-1">
            <Input
              value={newFileName}
              onChange={(e) => {
                setNewFileName(e.target.value);
                setNewFileError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleCreateFile();
                }
              }}
              placeholder={t("promptNewFilePlaceholder")}
              className="h-7 text-[12px]"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={handleCreateFile}
              disabled={!newFileName.trim()}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          {newFileError && (
            <span className="text-[11px] text-destructive">{newFileError}</span>
          )}
        </div>
      </div>

      {/* 右区：正文编辑 */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
        {contentLoading ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : contentLoadFailed ? (
          <Alert variant="destructive">
            <AlertDescription>{t("promptContentLoadFailed")}</AlertDescription>
          </Alert>
        ) : (
          <>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-0 flex-1 resize-none font-mono text-[12.5px] leading-relaxed"
              placeholder={t("promptContentPlaceholder")}
            />
            {saveError && (
              <Alert variant="destructive">
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
            )}
            <div className="flex shrink-0 justify-end">
              <Button
                type="button"
                onClick={() => void handleSave()}
                disabled={!dirty || saving}
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {saving ? t("promptSaving") : t("promptSave")}
              </Button>
            </div>
          </>
        )}
      </div>

      {/* 切换文件时的未保存确认（纯内部导航） */}
      <ConfirmDialog
        open={switchTarget !== null}
        title={t("discardTitle")}
        description={t("discardDescription")}
        confirmText={t("discardConfirm")}
        cancelText={t("discardCancel")}
        destructive
        onConfirm={() => {
          const target = switchTarget;
          setSwitchTarget(null);
          discardCurrent();
          if (target) void loadContent(target);
        }}
        onCancel={() => setSwitchTarget(null)}
      />

      {/* 删除文件确认 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("promptDeleteConfirmTitle", { file: deleteTarget ?? "" })}
        description={t("promptDeleteConfirmDescription")}
        confirmText={t("deleteConfirm")}
        cancelText={t("cancel")}
        destructive
        loading={deleting}
        onConfirm={() => void handleDeleteConfirmed()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
});
