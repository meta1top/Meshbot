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
  Switch,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@meshbot/design";
import { Form, FormItem } from "@meshbot/design/form";
import { useSchema } from "@meshbot/design/hooks";
import {
  AgentCreateSchema,
  DEFAULT_AGENT_AVATAR,
  QUICK_ASSISTANT_NAME_MAX,
} from "@meshbot/types-agent";
import { useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { Loader2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { forwardRef, useEffect, useState } from "react";
import { type ZodType, z } from "zod";
import { sessionsAtom } from "@/atoms/sessions";
import { AgentAvatarField } from "@/components/agent/agent-avatar-field";
import { McpEditor } from "@/components/agent/mcp-editor";
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

const RemoteEnabledField = forwardRef<
  HTMLButtonElement,
  { value?: boolean; onChange?: (value: boolean) => void }
>(({ value, onChange }, ref) => (
  <Switch ref={ref} checked={value ?? false} onCheckedChange={onChange} />
));
RemoteEnabledField.displayName = "RemoteEnabledField";

/**
 * 编辑抽屉表单 Schema：在 `AgentCreateSchema` 基础上加 `remoteEnabled`
 * 开关（计划二 2b）。只在编辑态渲染/提交这个字段（新建 Agent 尚无 id，
 * 「允许远程」在创建当下没有意义），但为了让 `<Form>` 单一 schema 覆盖
 * 新建/编辑两态，字段本身始终存在、给个 `false` 默认值。
 */
const AgentEditorFormSchema = AgentCreateSchema.extend({
  remoteEnabled: z.boolean().default(false),
});
type AgentFormValues = z.infer<typeof AgentEditorFormSchema>;

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
 * `handleDuplicate` 改写，脱离 prop 独立驱动 UI。
 *
 * 无全局「当前 Agent」概念（Agent 并列，各处就地选）：删除 Agent 后不再
 * 切换任何「当前」，只在「正打开的会话恰好属于被删 Agent」时导航离开
 * （见 `handleDelete`）。
 */
export function AgentEditorSheet({
  agentId,
  open,
  onOpenChange,
}: AgentEditorSheetProps) {
  const t = useTranslations("agent.editor");
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const sessions = useAtomValue(sessionsAtom);
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
  // react-hook-form 的 `defaultValues` 只在 `<Form>` 挂载那一刻生效，之后
  // `current` 变化不会让表单重新取值（RHF 已知行为，非 bug）。编辑态下若在
  // agents 列表尚未加载完成时就挂载 `<Form>`，defaultValues 会被冻结成空
  // 字符串——用户什么都没删，保存时却把这份「看起来是用户清空」的空值原样
  // 提交，后端 `AgentService.update()` 走的是 `Object.assign` 部分覆盖语义，
  // 无法分辨「真清空」与「表单没读到值」，于是把已保存的 systemPrompt 覆盖
  // 成空串——这正是「系统提示词保存后失效 / 重新打开看不到」的根因。
  // 用「数据就绪前不挂载 `<Form>`」根治：确保挂载时 defaultValues 一定来自
  // 已加载好的真实 Agent 数据。
  const agentsReady = agents !== undefined;
  const current = agentsReady
    ? (agents.find((a) => a.id === localAgentId) ?? null)
    : null;
  const canDelete = (agents?.length ?? 0) > 1;
  const duplicateCandidates = agents ?? [];
  // 新建态不依赖 agents 加载（没有既有数据要等）；编辑态必须等 agents 就绪
  // 且能找到目标 Agent，才允许 `<Form>` 挂载。
  const formReady = mode === "create" || (agentsReady && current !== null);
  const agentMissing = mode === "edit" && agentsReady && current === null;

  // AgentEditorFormSchema 的 description/systemPrompt/defaultModelConfigId/
  // remoteEnabled 带 `.default()`：zod 的 Input 类型（可省略）与 Output 类型
  // （`AgentFormValues`，已套默认值、必填）天然不同，而 `<Form>` 的泛型要求
  // `ZodType<T>`（Input===Output===T）。这里始终传完整 defaultValues（没有
  // 字段会真的走 undefined），运行时行为不受影响，只是结构类型对不上——按
  // zod + react-hook-form 生态的通用处理方式做一次类型断言，而不是为了迁就
  // 类型系统另开一份表单专用 schema（那样就不是「直接复用 AgentCreateSchema」
  // 了）。
  const schema = useSchema(
    AgentEditorFormSchema,
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
        // 创建接口（AgentCreateSchema）不认识 remoteEnabled——新建 Agent
        // 尚无 id，「允许远程」要等有 id 之后才有意义，这里剔除掉，只走
        // 编辑态提交。
        const { remoteEnabled: _remoteEnabled, ...createValues } = values;
        await createAgent(createValues);
        await invalidateAgents();
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
      await deleteAgent(localAgentId);
      await invalidateAgents();
      // 无「当前 Agent」可切——只在「正打开的会话恰好属于被删 Agent」时导航
      // 离开（该会话已不可续聊）；删除的是别的 Agent 时，当前打开的会话与
      // 侧栏展开态都不受影响。
      const openSessionId =
        pathname === "/assistant" ? searchParams.get("id") : null;
      const openSession = openSessionId
        ? sessions.find((s) => s.id === openSessionId)
        : null;
      if (openSession?.agentId === localAgentId) {
        router.push("/assistant");
      }
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

          {!formReady && !agentMissing && (
            <div className="flex flex-1 items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("loadingAgent")}
            </div>
          )}

          {agentMissing && (
            <div className="flex flex-1 items-center justify-center py-10 text-[13px] text-muted-foreground">
              {t("agentNotFound")}
            </div>
          )}

          {formReady && (
            <Form
              key={localAgentId ?? "create"}
              schema={schema}
              defaultValues={{
                name: current?.name ?? "",
                avatar: current?.avatar ?? DEFAULT_AGENT_AVATAR,
                description: current?.description ?? "",
                systemPrompt: current?.systemPrompt ?? "",
                defaultModelConfigId: current?.defaultModelConfigId ?? null,
                remoteEnabled: current?.remoteEnabled ?? false,
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

              {mode === "edit" && (
                <FormItem
                  name="remoteEnabled"
                  label={t("fieldRemoteEnabled")}
                  description={t("fieldRemoteEnabledHint")}
                >
                  <RemoteEnabledField />
                </FormItem>
              )}

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
                  {submitting && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  {submitting ? t("saving") : t("save")}
                </Button>
              </SheetFooter>
            </Form>
          )}

          {/* MCP 配置：独立于上面的 Agent 身份表单（各自保存），只在编辑既有
              Agent 时展示——新建态尚无 agentId，MCP 端点挂在 /api/agents/:id/mcp
              下，没有 id 无处可读写；同时要求 formReady，避免和上面的加载态
              同屏出现半截 UI。 */}
          {mode === "edit" && localAgentId && formReady && (
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
