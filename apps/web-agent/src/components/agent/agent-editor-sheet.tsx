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
import { SheetTabBar, UnifiedSheet } from "@meshbot/web-common/shell";
import { useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { useAtomValue } from "jotai";
import { Loader2, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { forwardRef, useEffect, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { type ZodType, z } from "zod";
import { sessionsAtom } from "@/atoms/sessions";
import { AgentAvatarField } from "@/components/agent/agent-avatar-field";
import { McpEditor } from "@/components/agent/mcp-editor";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import {
  agentsQueryKey,
  createAgent,
  deleteAgent,
  duplicateAgent,
  getAgentMcp,
  putAgentMcp,
  updateAgent,
  useAgents,
} from "@/rest/agents";
import type { ModelConfig } from "@/rest/model-config";
import { useModelConfigs } from "@/rest/model-config";

/** Radix Select 不允许 value="" —— 用哨兵值表示「跟随账号默认」，提交前后转换。 */
const ACCOUNT_DEFAULT_VALUE = "__account_default__";

/** 基本信息 <form> 的 id：固定 footer 里的提交按钮靠 `form` 属性关联它。 */
const AGENT_EDITOR_FORM_ID = "agent-editor-form";

/** mcp.json 默认占位文本，与后端 GET 空态返回值保持一致（见
 *  `apps/server-agent/src/controllers/agent.controller.ts` 的 `getMcp`）。
 *  新建向导 / 尚未加载完成的编辑态都以它为初值。 */
const DEFAULT_MCP_RAW = '{\n  "mcpServers": {}\n}\n';

/**
 * 校验 mcp 文本是否为合法 JSON；空白视为合法（等价「未填写」）。
 * 合法返回 null，非法返回 JSON.parse 抛出的原始 message，调用方套 i18n 文案。
 */
function mcpJsonSyntaxError(raw: string): string | null {
  if (raw.trim() === "") return null;
  try {
    JSON.parse(raw);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * mcp 文本在语义上是否等价于「空/默认配置」（空白或 `{"mcpServers": {}}`）——
 * 新建向导「创建」时用来判断要不要额外调用一次 MCP 保存接口（agent 刚创建，
 * 本就没有 mcp.json，等价空值没必要发这次请求）。调用前应已过
 * {@link mcpJsonSyntaxError} 校验（非法 JSON 在这里按「非默认」处理，不阻断）。
 */
function isMcpDefaultValue(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return true;
  try {
    return (
      JSON.stringify(JSON.parse(trimmed)) === JSON.stringify({ mcpServers: {} })
    );
  } catch {
    return false;
  }
}

/**
 * 从错误对象里提取展示文案：优先取后端 400 响应体的 `message`（如 MCP JSON
 * 结构校验失败的具体原因），其次取 Error.message，都没有则用调用方给的兜底。
 */
function extractErrorMessage(err: unknown, fallback: string): string {
  if (
    axios.isAxiosError(err) &&
    err.response?.data &&
    typeof err.response.data === "object" &&
    "message" in err.response.data &&
    typeof (err.response.data as { message?: unknown }).message === "string"
  ) {
    return (err.response.data as { message: string }).message;
  }
  return err instanceof Error ? err.message : fallback;
}

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
  const tCommon = useTranslations("common");
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
  const [tab, setTab] = useState<"basic" | "mcp">("basic");
  const [discardOpen, setDiscardOpen] = useState(false);
  // 新建态改「步骤条」：null = 非向导（真实编辑，或已通过「从现有 Agent
  // 复制」直接拿到成品 Agent）；1 = 步骤一（基本信息，尚无 id，只做本地校验，
  // 不发请求）；2 = 步骤二（MCP，留空可跳过；点「创建」才真正创建 agent，
  // 若 MCP 非默认值再一并提交）。
  const [wizardStep, setWizardStep] = useState<1 | 2 | null>(() =>
    agentId === null ? 1 : null,
  );
  const formApiRef = useRef<UseFormReturn<AgentFormValues> | null>(null);

  // 受控 MCP 编辑器状态：`mcpInitial` 是加载/进入时的基线（编辑态=后端已存的
  // mcp.json，向导态=默认占位文本），`mcpValue` 是当前编辑值——两者比较用于
  // 脏判定与「编辑态保存时是否需要一并提交 MCP」。
  const [mcpValue, setMcpValue] = useState(DEFAULT_MCP_RAW);
  const [mcpInitial, setMcpInitial] = useState(DEFAULT_MCP_RAW);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpLoadFailed, setMcpLoadFailed] = useState(false);

  /** 关闭意图入口：表单脏或 MCP 文本相对基线有改动，先弹放弃确认，否则直接
   *  关。X 按钮 / ESC 都走这里；遮罩点击不走（见 onDismissAttempt）。
   *  向导步骤二关闭 = 放弃整个新建（agent 尚未创建），同样要经过这个脏判定
   *  ——能走到步骤二说明步骤一至少填过必填项，表单必然脏，不会被误判成
   *  「无改动直接关」。 */
  const requestClose = () => {
    const formDirty = formApiRef.current?.formState.isDirty ?? false;
    const mcpDirty = mcpValue !== mcpInitial;
    if (formDirty || mcpDirty) setDiscardOpen(true);
    else onOpenChange(false);
  };

  // 抽屉每次从关到开都以 prop 为准重置——复制流程在「开着」期间改写
  // localAgentId，不受这个 effect 影响（它只在 open 变化时跑，故意不带 agentId
  // 依赖：agentId 变化但 open 未变化时不应该打断正在编辑的复制态）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 有意只依赖 open
  useEffect(() => {
    if (open) {
      setLocalAgentId(agentId);
      setError(null);
      setDeleteConfirmOpen(false);
      setTab("basic");
      setDiscardOpen(false);
      // 以 prop 为准：agentId 为 null 才是新建态，进步骤条步骤一。
      setWizardStep(agentId === null ? 1 : null);
      setMcpValue(DEFAULT_MCP_RAW);
      setMcpInitial(DEFAULT_MCP_RAW);
      setMcpError(null);
      setMcpLoadFailed(false);
      setMcpLoading(false);
    }
  }, [open]);

  // 真实编辑态（非向导）加载该 Agent 现有的 mcp.json，按 localAgentId 隔离
  // （复制流程切换 id 后重新拉取）。向导态（wizardStep !== null）故意不在这里
  // 处理：步骤二的 MCP 是用户正在填的本地新值，不该被 GET 结果覆盖——包括
  // 「agent 已创建但 MCP 保存失败」后停留在步骤二重试的场景，此时
  // localAgentId 已非空但 wizardStep 仍是 2。
  useEffect(() => {
    if (!open || wizardStep !== null || !localAgentId) return;
    let cancelled = false;
    setMcpLoading(true);
    setMcpLoadFailed(false);
    setMcpError(null);
    getAgentMcp(localAgentId)
      .then((res) => {
        if (cancelled) return;
        setMcpValue(res.raw);
        setMcpInitial(res.raw);
      })
      .catch(() => {
        if (!cancelled) setMcpLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setMcpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, wizardStep, localAgentId]);

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

  /**
   * `<Form>` 的 onSubmit：走到这里说明 RHF + zodResolver 已经校验通过。
   *
   * - 向导步骤一「下一步」：只切步骤，不发任何请求——创建被推迟到步骤二
   *   「创建」（见 {@link handleCreate}），这里只负责本地校验 + 前进。
   * - 真实编辑态「保存」：基本信息 + （若有改动）MCP 配置一起提交。
   *
   * 向导步骤二的「创建」不走这条路径：它是独立按钮（type="button"），手动
   * 用 `formApiRef.current?.getValues()` 取基本信息，理由见 handleCreate 注释。
   */
  const handleSubmit = async (values: AgentFormValues) => {
    if (wizardStep === 1) {
      setTab("mcp");
      setWizardStep(2);
      return;
    }
    if (mode !== "edit" || !localAgentId) return; // 理论不可达，收窄类型

    let mcpPayload: string | null = null;
    if (mcpValue !== mcpInitial) {
      const syntaxErr = mcpJsonSyntaxError(mcpValue);
      if (syntaxErr) {
        setMcpError(t("mcpJsonInvalid", { detail: syntaxErr }));
        setTab("mcp");
        return; // 阻断保存：基本信息也不提交
      }
      // 变化了但清空成空白 ≠「跳过提交」（那是向导态新建的语义，agent 尚无
      // mcp.json 无需创建）——编辑态文件已存在，必须显式写回默认态才能真正
      // 清空已保存的配置。
      mcpPayload = mcpValue.trim() === "" ? DEFAULT_MCP_RAW : mcpValue;
    }

    setSubmitting(true);
    setError(null);
    try {
      await updateAgent(localAgentId, values);
      if (mcpPayload !== null) {
        await putAgentMcp(localAgentId, { raw: mcpPayload });
        setMcpInitial(mcpPayload);
        setMcpValue(mcpPayload);
      }
      await invalidateAgents();
      onOpenChange(false);
    } catch (err) {
      setError(extractErrorMessage(err, t("saveFailed")));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * 向导步骤二「创建」：一次性完成「创建 agent →（MCP 非默认值时）提交 MCP
   * 配置 → 刷新列表 → 关闭」。
   *
   * 用 `getValues()` 而不是把这个按钮也接进 `<Form>` 的 submit 路径——一是
   * 「上一步」是 type="button"，两个按钮语义不对称没必要都走 submit；二是
   * 失败恢复要能在不重新触发表单校验事件的前提下单独重试 MCP 这一步。
   *
   * 失败恢复（防重复创建）：createAgent 成功但 MCP 保存失败时，`localAgentId`
   * 已经落回真实 id——下次点「创建」会因为 `agentId`（=localAgentId）非空
   * 跳过 createAgent 分支，只重试 MCP 提交。
   */
  const handleCreate = async () => {
    setError(null);
    const syntaxErr = mcpJsonSyntaxError(mcpValue);
    if (syntaxErr) {
      setMcpError(t("mcpJsonInvalid", { detail: syntaxErr }));
      return;
    }
    const mcpPayload = isMcpDefaultValue(mcpValue) ? null : mcpValue;

    setSubmitting(true);
    try {
      let agentId = localAgentId;
      if (!agentId) {
        const values = formApiRef.current?.getValues();
        if (!values) throw new Error(t("saveFailed"));
        // 创建接口（AgentCreateSchema）不认识 remoteEnabled——新建 Agent
        // 尚无 id，「允许远程」要等有 id 之后才有意义，这里剔除掉。
        const { remoteEnabled: _remoteEnabled, ...createValues } = values;
        const created = await createAgent(createValues);
        agentId = created.id;
        setLocalAgentId(agentId);
        // 立即失效缓存，而不是拖到 MCP 也提交完——`mode`（= localAgentId ?
        // "edit" : "create"）这一帧起就会翻成 "edit"，若 agents 列表缓存没
        // 跟上，`formReady`/`agentMissing` 会把刚创建的 agent 误判成「不存在」
        // （agentsReady && current===null），基本信息 <Form> 被整个卸载——
        // MCP 保存失败后退回步骤一查看基本信息会看到「Agent 已被删除」的假象。
        await invalidateAgents();
      }
      if (mcpPayload !== null) {
        await putAgentMcp(agentId, { raw: mcpPayload });
      }
      onOpenChange(false);
    } catch (err) {
      setError(extractErrorMessage(err, t("saveFailed")));
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
      // 复制完成：脱离新建态/步骤条，把这个已打开的抽屉直接切到编辑新
      // agent——复制出来的已是成品配置，不需要再走「基本信息 → MCP」的
      // 步骤流程。
      setLocalAgentId(created.id);
      setWizardStep(null);
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

  // 底部固定动作条（UnifiedSheet `footer` 槽，不随正文滚动）：
  // - 步骤一：[取消] [下一步]——「下一步」是表单提交按钮，用 HTML `form`
  //   属性关联回 <form>，走 handleSubmit 的本地校验路径（也保住 Enter 隐式
  //   提交，行为与点按钮一致）。
  // - 步骤二：[上一步] [创建]——两者都是独立按钮，不进表单 submit 路径，
  //   「创建」走 handleCreate（一次性创建 agent + 提交 MCP）。
  // - 真实编辑态：[删除] [取消] [保存]——「保存」同样是表单提交按钮。
  const footerContent =
    wizardStep === 1 ? (
      <>
        <div className="flex-1" />
        <Button
          type="button"
          variant="outline"
          onClick={requestClose}
          disabled={submitting}
        >
          {t("cancel")}
        </Button>
        <Button
          type="submit"
          form={AGENT_EDITOR_FORM_ID}
          variant="brand"
          disabled={submitting}
        >
          {t("wizardNext")}
        </Button>
      </>
    ) : wizardStep === 2 ? (
      <>
        <div className="flex-1" />
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setWizardStep(1);
            setTab("basic");
          }}
          disabled={submitting}
        >
          {t("wizardBack")}
        </Button>
        <Button
          type="button"
          variant="brand"
          disabled={submitting}
          onClick={() => void handleCreate()}
        >
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {submitting ? t("saving") : t("wizardCreate")}
        </Button>
      </>
    ) : formReady ? (
      <>
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
          onClick={requestClose}
          disabled={submitting}
        >
          {t("cancel")}
        </Button>
        <Button type="submit" form={AGENT_EDITOR_FORM_ID} disabled={submitting}>
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {submitting ? t("saving") : t("save")}
        </Button>
      </>
    ) : null;

  return (
    <>
      <UnifiedSheet
        open={open}
        onOpenChange={onOpenChange}
        modal
        dismissible={false}
        // 表单类抽屉：点遮罩大概率是误触（正在填写时手滑点到旁边），零响应——
        // 不弹确认也不关闭；只有 ESC 走 requestClose 的脏确认逻辑，与头部 X
        // 按钮行为一致。
        onDismissAttempt={(source) => {
          if (source === "esc") requestClose();
        }}
        title={wizardStep !== null ? t("createTitle") : t("editTitle")}
        headerActions={
          <button
            type="button"
            aria-label={tCommon("close")}
            onClick={requestClose}
            className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        }
        headerTabs={
          wizardStep !== null ? (
            <SheetTabBar
              variant="steps"
              items={[
                { key: "basic", label: t("wizardStepBasic") },
                { key: "mcp", label: t("wizardStepMcp") },
              ]}
              active={tab}
            />
          ) : (
            <SheetTabBar
              items={[
                { key: "basic", label: t("tabBasic") },
                { key: "mcp", label: t("tabMcp") },
              ]}
              active={tab}
              onChange={(k) => setTab(k as "basic" | "mcp")}
            />
          )
        }
        footer={footerContent}
        minWidth={448}
        defaultWidth="28rem"
        // app-no-drag：把面板 z 抬出顶部 DragRegion，头部 X 按钮才可点（Electron）
        className="app-no-drag"
      >
        {/* keep-mounted：CSS 隐藏而非卸载，切 tab 不丢编辑中状态 */}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4",
            tab !== "basic" && "hidden",
          )}
        >
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
              id={AGENT_EDITOR_FORM_ID}
              formApiRef={formApiRef}
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
            </Form>
          )}
        </div>

        {/* MCP 配置：受控编辑器，不再自带保存按钮——步骤二随「创建」提交，
            真实编辑态随 footer「保存」与基本信息一起提交。步骤一（尚无
            agentId、也没有本地 MCP 编辑意图）不渲染；真实编辑态额外要求
            formReady，避免和加载态同屏出现半截 UI。 */}
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto p-4",
            tab !== "mcp" && "hidden",
          )}
        >
          {(wizardStep === 2 ||
            (wizardStep === null && mode === "edit" && formReady)) && (
            <McpEditor
              value={mcpValue}
              onChange={(v) => {
                setMcpValue(v);
                setMcpError(null);
              }}
              error={mcpError}
              loading={mcpLoading}
              loadFailed={mcpLoadFailed}
            />
          )}
        </div>
      </UnifiedSheet>

      <ConfirmDialog
        open={discardOpen}
        title={t("discardTitle")}
        description={t("discardDescription")}
        confirmText={t("discardConfirm")}
        cancelText={t("discardCancel")}
        destructive
        onConfirm={() => {
          setDiscardOpen(false);
          onOpenChange(false);
        }}
        onCancel={() => setDiscardOpen(false)}
      />

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
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
    </>
  );
}
