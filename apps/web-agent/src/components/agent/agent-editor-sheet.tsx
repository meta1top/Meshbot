"use client";

import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  buttonVariants,
  cn,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@meshbot/design";
import { Form, FormItem } from "@meshbot/design/form";
import { useSchema } from "@meshbot/design/hooks";
import {
  type AgentCreateInput,
  AgentCreateSchema,
  DEFAULT_AGENT_AVATAR,
  QUICK_ASSISTANT_NAME_MAX,
} from "@meshbot/types-agent";
import { useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { forwardRef, useEffect, useState } from "react";
import type { ZodType } from "zod";
import { currentAgentIdAtom } from "@/atoms/agent";
import { AgentAvatarField } from "@/components/agent/agent-avatar-field";
import { McpEditor } from "@/components/agent/mcp-editor";
import { nextSelectedAgentId } from "@/lib/next-selected-agent-id";
import {
  agentsQueryKey,
  createAgent,
  deleteAgent,
  duplicateAgent,
  updateAgent,
  useAgents,
} from "@/rest/agents";
import type { ModelConfig } from "@/rest/model-config";
import { useModelConfigs } from "@/rest/model-config";

/** Radix Select 不允许 value="" —— 用哨兵值表示「跟随账号默认」，提交前后转换。 */
const ACCOUNT_DEFAULT_VALUE = "__account_default__";

const DefaultModelField = forwardRef<
  HTMLButtonElement,
  {
    value?: string | null;
    onChange?: (value: string | null) => void;
    configs: ModelConfig[];
  }
>(({ value, onChange, configs }, ref) => {
  const t = useTranslations("agent.editor");
  const enabled = configs.filter((c) => c.enabled);
  return (
    <Select
      value={value ?? ACCOUNT_DEFAULT_VALUE}
      onValueChange={(next) =>
        onChange?.(next === ACCOUNT_DEFAULT_VALUE ? null : next)
      }
    >
      <SelectTrigger ref={ref}>
        <SelectValue placeholder={t("fieldDefaultModelPlaceholder")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ACCOUNT_DEFAULT_VALUE}>
          {t("fieldDefaultModelFollowAccount")}
        </SelectItem>
        {enabled.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});
DefaultModelField.displayName = "DefaultModelField";

type AgentFormValues = AgentCreateInput;

interface AgentEditorSheetProps {
  /** 编辑目标 Agent id；null = 新建模式。 */
  agentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Agent 编辑抽屉：新建 / 编辑 / 复制 / 删除。
 *
 * 「复制」需要在同一次打开会话里把抽屉从「新建」切到「编辑新 agent」，
 * 而 `agentId` 是父组件受控的 prop（由 `assistant-sidebar` 触发，只会传
 * null 或某个既有 agent id，不知道复制诞生的新 id）——用 `localAgentId`
 * 内部状态承接：每次抽屉从关到开都用 prop 重置一次，但打开期间可以被
 * `handleDuplicate` 改写，脱离 prop 独立驱动 UI，同时把 `currentAgentIdAtom`
 * 也切过去,让侧栏与抽屉的「当前 agent」认知保持一致。
 */
export function AgentEditorSheet({
  agentId,
  open,
  onOpenChange,
}: AgentEditorSheetProps) {
  const t = useTranslations("agent.editor");
  const queryClient = useQueryClient();
  const [currentAgentId, setCurrentAgentId] = useAtom(currentAgentIdAtom);
  const { data: agents } = useAgents();
  const { data: modelConfigs } = useModelConfigs();

  const [localAgentId, setLocalAgentId] = useState<string | null>(agentId);
  const [submitting, setSubmitting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 抽屉每次从关到开都以 prop 为准重置——复制流程在「开着」期间改写
  // localAgentId，不受这个 effect 影响（它只在 open 变化时跑，故意不带 agentId
  // 依赖：agentId 变化但 open 未变化时不应该打断正在编辑的复制态）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 有意只依赖 open
  useEffect(() => {
    if (open) {
      setLocalAgentId(agentId);
      setError(null);
      setDeleteConfirmOpen(false);
    }
  }, [open]);

  const mode: "create" | "edit" = localAgentId ? "edit" : "create";
  const current = agents?.find((a) => a.id === localAgentId) ?? null;
  const canDelete = (agents?.length ?? 0) > 1;
  const duplicateCandidates = agents ?? [];

  // AgentCreateSchema 的 description/systemPrompt/defaultModelConfigId 带
  // `.default()`：zod 的 Input 类型（可省略）与 Output 类型（`AgentFormValues`，
  // 已套默认值、必填）天然不同，而 `<Form>` 的泛型要求 `ZodType<T>`（Input===
  // Output===T）。这里始终传完整 defaultValues（没有字段会真的走 undefined），
  // 运行时行为不受影响，只是结构类型对不上——按 zod + react-hook-form 生态的
  // 通用处理方式做一次类型断言，而不是为了迁就类型系统另开一份表单专用
  // schema（那样就不是「直接复用 AgentCreateSchema」了）。
  const schema = useSchema(
    AgentCreateSchema,
  ) as unknown as ZodType<AgentFormValues>;

  async function invalidateAgents() {
    await queryClient.invalidateQueries({ queryKey: agentsQueryKey });
  }

  const handleSubmit = async (values: AgentFormValues) => {
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "edit" && localAgentId) {
        await updateAgent(localAgentId, values);
        await invalidateAgents();
      } else {
        const created = await createAgent(values);
        await invalidateAgents();
        setCurrentAgentId(created.id);
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDuplicate = async (sourceId: string) => {
    if (!sourceId || duplicating) return;
    setDuplicating(true);
    setError(null);
    try {
      const created = await duplicateAgent(sourceId);
      await invalidateAgents();
      setCurrentAgentId(created.id);
      // 复制完成：脱离新建态，把这个已打开的抽屉直接切到编辑新 agent。
      setLocalAgentId(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("duplicateFailed"));
    } finally {
      setDuplicating(false);
    }
  };

  const handleDelete = async () => {
    if (!localAgentId || !canDelete) return;
    setDeleting(true);
    setError(null);
    try {
      const remaining = (agents ?? []).filter((a) => a.id !== localAgentId);
      await deleteAgent(localAgentId);
      await invalidateAgents();
      // 只有删的就是当前选中的 agent 才需要切走；删别的 agent 时当前选中保持不变
      // （之前无条件切到 remaining[0]，会把用户正在对话的 agent 静默切走）。
      setCurrentAgentId(
        nextSelectedAgentId(localAgentId, currentAgentId, remaining),
      );
      setDeleteConfirmOpen(false);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("deleteFailed"));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle>
            {mode === "edit" ? t("editTitle") : t("createTitle")}
          </SheetTitle>
          <SheetDescription>
            {mode === "edit" ? t("editDescription") : t("createDescription")}
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {mode === "create" && duplicateCandidates.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-border p-3">
              <span className="text-[13px] font-medium text-foreground/85">
                {t("duplicateFromLabel")}
              </span>
              <Select
                onValueChange={handleDuplicate}
                disabled={duplicating}
                value=""
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("duplicateFromPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {duplicateCandidates.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {duplicating && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("duplicating")}
                </span>
              )}
            </div>
          )}

          <Form
            key={localAgentId ?? "create"}
            schema={schema}
            defaultValues={{
              name: current?.name ?? "",
              avatar: current?.avatar ?? DEFAULT_AGENT_AVATAR,
              description: current?.description ?? "",
              systemPrompt: current?.systemPrompt ?? "",
              defaultModelConfigId: current?.defaultModelConfigId ?? null,
            }}
            onSubmit={handleSubmit}
            className="flex flex-col gap-4"
          >
            <FormItem name="name" label={t("fieldName")}>
              <Input
                maxLength={QUICK_ASSISTANT_NAME_MAX}
                placeholder={t("fieldNamePlaceholder")}
              />
            </FormItem>

            <FormItem name="avatar" label={t("fieldAvatar")}>
              <AgentAvatarField />
            </FormItem>

            <FormItem name="description" label={t("fieldDescription")}>
              <Input placeholder={t("fieldDescriptionPlaceholder")} />
            </FormItem>

            <FormItem name="systemPrompt" label={t("fieldSystemPrompt")}>
              <Textarea
                rows={10}
                className="min-h-40 resize-y font-mono text-[12.5px] leading-relaxed"
                placeholder={t("fieldSystemPromptPlaceholder")}
              />
            </FormItem>

            <FormItem
              name="defaultModelConfigId"
              label={t("fieldDefaultModel")}
            >
              <DefaultModelField configs={modelConfigs ?? []} />
            </FormItem>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <SheetFooter className="border-t-0 px-0 pt-0">
              {mode === "edit" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* disabled 按钮包一层 span：Radix Tooltip 需要可聚焦/可 hover
                        的触发元素，disabled button 不派发 mouseenter。 */}
                    <span className={cn(!canDelete && "cursor-not-allowed")}>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={!canDelete}
                        className={cn(!canDelete && "pointer-events-none")}
                        onClick={() => setDeleteConfirmOpen(true)}
                      >
                        {t("delete")}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {!canDelete && (
                    <TooltipContent side="top">
                      {t("deleteDisabledHint")}
                    </TooltipContent>
                  )}
                </Tooltip>
              )}
              <div className="flex-1" />
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {submitting ? t("saving") : t("save")}
              </Button>
            </SheetFooter>
          </Form>

          {/* MCP 配置：独立于上面的 Agent 身份表单（各自保存），只在编辑既有
              Agent 时展示——新建态尚无 agentId，MCP 端点挂在 /api/agents/:id/mcp
              下，没有 id 无处可读写。 */}
          {mode === "edit" && localAgentId && (
            <>
              <div className="h-px bg-border" />
              <McpEditor agentId={localAgentId} />
            </>
          )}
        </div>

        <AlertDialog
          open={deleteConfirmOpen}
          onOpenChange={setDeleteConfirmOpen}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("deleteConfirmDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>
                {t("cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={deleting}
                className={buttonVariants({ variant: "destructive" })}
                onClick={(e) => {
                  e.preventDefault();
                  handleDelete();
                }}
              >
                {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {deleting ? t("deleting") : t("deleteConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
