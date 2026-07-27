"use client";

import {
  Alert,
  AlertDescription,
  Button,
  cn,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
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
import { Loader2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { forwardRef, useEffect, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { type ZodType, z } from "zod";
import { AgentAvatarField } from "@/components/agent/agent-avatar-field";
import { McpEditor } from "@/components/agent/mcp-editor";
import {
  PromptFilesEditor,
  type PromptFilesEditorHandle,
} from "@/components/agent/prompt-files-editor";
import { SkillManager } from "@/components/agent/skill-manager";
import { ToolPrefsEditor } from "@/components/agent/tool-prefs-editor";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import {
  agentsQueryKey,
  createAgent,
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
 * Agent 编辑抽屉：新建（单步表单）/ 编辑（基本信息 + 提示词 + MCP 三 tab）。
 *
 * 「从现有 Agent 复制」与「删除」两个入口都已移出本组件，改到侧栏 Agent 行
 * 下拉菜单（见 `assistant-sidebar.tsx`）——编辑态因此不再有 footer：三个 tab
 * 各自管自己的保存，关闭只走头部 X（`headerActions`，走 `requestClose` 的脏
 * 确认逻辑）。新建态恒是单步表单：name/avatar/description/defaultModel，创建
 * 成功直接关闭。
 */
export function AgentEditorSheet({
  agentId,
  open,
  onOpenChange,
}: AgentEditorSheetProps) {
  const t = useTranslations("agent.editor");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const { data: agents } = useAgents();
  const { data: modelConfigs } = useModelConfigs();

  const [localAgentId, setLocalAgentId] = useState<string | null>(agentId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  type EditorTab = "basic" | "prompts" | "skills" | "mcp" | "tools";
  const [tab, setTab] = useState<EditorTab>("basic");
  const [discardOpen, setDiscardOpen] = useState(false);
  // 未保存切 tab（离开「提示词」时）待确认的目标 tab；null 表示当前弹出的
  // discardOpen 确认框是「关闭整个抽屉」而非「切 tab」，两者共用同一个确认框。
  const [pendingTab, setPendingTab] = useState<EditorTab | null>(null);
  // 提示词 tab 当前选中文件是否有未保存改动——由 PromptFilesEditor 冒泡上来，
  // 并入 requestClose / 切 tab 的脏检测。
  const [promptDirty, setPromptDirty] = useState(false);
  const promptEditorRef = useRef<PromptFilesEditorHandle>(null);
  const formApiRef = useRef<UseFormReturn<AgentFormValues> | null>(null);

  // 受控 MCP 编辑器状态：`mcpInitial` 是加载/进入时的基线（编辑态=后端已存的
  // mcp.json，向导态=默认占位文本），`mcpValue` 是当前编辑值——两者比较用于
  // 脏判定（并入 requestClose 的聚合脏检测）。编辑态下 MCP tab 自带保存
  // 按钮独立提交，不再随基本信息一起走 footer「保存」。
  const [mcpValue, setMcpValue] = useState(DEFAULT_MCP_RAW);
  const [mcpInitial, setMcpInitial] = useState(DEFAULT_MCP_RAW);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpLoadFailed, setMcpLoadFailed] = useState(false);
  const [mcpSaving, setMcpSaving] = useState(false);

  /** 关闭意图入口：表单脏 / MCP 文本相对基线有改动 / 提示词当前文件有未保存
   *  改动，先弹放弃确认，否则直接关。X 按钮 / ESC 都走这里；遮罩点击不走
   *  （见 onDismissAttempt）。`pendingTab` 置空表示这次确认框是「关闭整个
   *  抽屉」的语义（区别于切 tab 的确认，见下方 tab 切换处理）。 */
  const requestClose = () => {
    const formDirty = formApiRef.current?.formState.isDirty ?? false;
    const mcpDirty = mcpValue !== mcpInitial;
    if (formDirty || mcpDirty || promptDirty) {
      setPendingTab(null);
      setDiscardOpen(true);
    } else {
      onOpenChange(false);
    }
  };

  /** 切 tab 请求入口：离开「提示词」且当前文件有未保存改动时先弹放弃确认
   *  （复用 discardOpen 同一个确认框，`pendingTab` 记录确认后要切到的 tab）；
   *  其余情况直接切换。 */
  const requestTabChange = (next: EditorTab) => {
    if (tab === "prompts" && promptDirty && next !== "prompts") {
      setPendingTab(next);
      setDiscardOpen(true);
      return;
    }
    setTab(next);
  };

  // 抽屉每次从关到开都以 prop 为准重置。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 有意只依赖 open
  useEffect(() => {
    if (open) {
      setLocalAgentId(agentId);
      setError(null);
      setTab("basic");
      setDiscardOpen(false);
      setPendingTab(null);
      setPromptDirty(false);
      setMcpValue(DEFAULT_MCP_RAW);
      setMcpInitial(DEFAULT_MCP_RAW);
      setMcpError(null);
      setMcpLoadFailed(false);
      setMcpLoading(false);
      setMcpSaving(false);
    }
  }, [open]);

  // 编辑态加载该 Agent 现有的 mcp.json，按 localAgentId 隔离；`!localAgentId`
  // 已隐含新建态跳过（新建态没有既有 mcp.json 可拉）。
  useEffect(() => {
    if (!open || !localAgentId) return;
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
  }, [open, localAgentId]);

  const mode: "create" | "edit" = localAgentId ? "edit" : "create";
  // react-hook-form 的 `defaultValues` 只在 `<Form>` 挂载那一刻生效，之后
  // `current` 变化不会让表单重新取值（RHF 已知行为，非 bug）。编辑态下若在
  // agents 列表尚未加载完成时就挂载 `<Form>`，defaultValues 会被冻结成空
  // 字符串——用户什么都没删，保存时却把这份「看起来是用户清空」的空值原样
  // 提交，后端 `AgentService.update()` 走的是 `Object.assign` 部分覆盖语义，
  // 无法分辨「真清空」与「表单没读到值」，会把已保存字段覆盖成空串。
  // 用「数据就绪前不挂载 `<Form>`」根治：确保挂载时 defaultValues 一定来自
  // 已加载好的真实 Agent 数据。
  const agentsReady = agents !== undefined;
  const current = agentsReady
    ? (agents.find((a) => a.id === localAgentId) ?? null)
    : null;
  // 新建态不依赖 agents 加载（没有既有数据要等）；编辑态必须等 agents 就绪
  // 且能找到目标 Agent，才允许 `<Form>` 挂载。
  const formReady = mode === "create" || (agentsReady && current !== null);
  const agentMissing = mode === "edit" && agentsReady && current === null;

  // AgentEditorFormSchema 的 description/defaultModelConfigId/
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
   * - 新建态：单步表单直接创建（`remoteEnabled` 尚无 id 时没有意义，提交前剔除），
   *   成功即刷新列表并关闭抽屉，不再有「创建后进 MCP 步骤」这一环——MCP/提示词
   *   留给创建完成后重新打开编辑抽屉配置。
   * - 编辑态：只提交基本信息——MCP / 提示词已改为各 tab 自管保存（见
   *   {@link handleMcpSave} 与 `PromptFilesEditor`），互不联动。成功后不关闭
   *   抽屉（footer 只剩「关闭」），用 `reset(values)` 把 RHF 脏基线复位到刚
   *   提交的值，保证「保存后关闭不触发脏确认」。
   */
  const handleSubmit = async (values: AgentFormValues) => {
    if (mode === "create") {
      setSubmitting(true);
      setError(null);
      try {
        // 创建接口（AgentCreateSchema）不认识 remoteEnabled——新建 Agent
        // 尚无 id，「允许远程」要等有 id 之后才有意义，这里剔除掉。
        const { remoteEnabled: _remoteEnabled, ...createValues } = values;
        await createAgent(createValues);
        await invalidateAgents();
        onOpenChange(false);
      } catch (err) {
        setError(extractErrorMessage(err, t("saveFailed")));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!localAgentId) return; // 理论不可达，收窄类型

    setSubmitting(true);
    setError(null);
    try {
      await updateAgent(localAgentId, values);
      await invalidateAgents();
      formApiRef.current?.reset(values);
    } catch (err) {
      setError(extractErrorMessage(err, t("saveFailed")));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * MCP tab 自己的保存动作：语法校验失败就地内联报错（不再像旧版那样跳转
   * tab），成功后把 `mcpInitial` 同步到刚提交的值——脏检测立即归零，不影响
   * requestClose 的聚合判定。
   */
  const handleMcpSave = async () => {
    if (!localAgentId) return;
    const syntaxErr = mcpJsonSyntaxError(mcpValue);
    if (syntaxErr) {
      setMcpError(t("mcpJsonInvalid", { detail: syntaxErr }));
      return;
    }
    // 变化了但清空成空白 ≠「跳过提交」——编辑态文件已存在，必须显式写回
    // 默认态才能真正清空已保存的配置。
    const payload = mcpValue.trim() === "" ? DEFAULT_MCP_RAW : mcpValue;
    setMcpSaving(true);
    setMcpError(null);
    try {
      await putAgentMcp(localAgentId, { raw: payload });
      setMcpInitial(payload);
      setMcpValue(payload);
    } catch (err) {
      setMcpError(extractErrorMessage(err, t("mcpSaveFailed")));
    } finally {
      setMcpSaving(false);
    }
  };

  // 底部固定动作条（UnifiedSheet `footer` 槽，不随正文滚动）：
  // - 新建态：[取消] [创建(brand)]——单步表单，「创建」是表单提交按钮。
  // - 编辑态：整体不出 footer（传 undefined）——三个 tab 各自管自己的保存，
  //   删除功能已迁到侧栏 Agent 行下拉菜单，关闭只走头部 X。
  const footerContent =
    formReady && mode === "create" ? (
      <>
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
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {submitting ? t("saving") : t("create")}
        </Button>
      </>
    ) : undefined;

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
        title={mode === "create" ? t("createTitle") : t("editTitle")}
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
        // 新建态是单步表单，不需要 tab 条；编辑态五 tab：基本信息/提示词/技能/MCP/工具。
        headerTabs={
          mode === "edit" ? (
            <SheetTabBar
              items={[
                { key: "basic", label: t("tabBasic") },
                { key: "prompts", label: t("tabPrompts") },
                { key: "skills", label: t("tabSkills") },
                { key: "mcp", label: t("tabMcp") },
                { key: "tools", label: t("tabTools") },
              ]}
              active={tab}
              onChange={(k) => requestTabChange(k as EditorTab)}
            />
          ) : undefined
        }
        footer={footerContent}
        minWidth={448}
        // 编辑态提示词 tab 是左右两栏结构（文件列表 + 正文），需要更宽的默认
        // 宽度才不挤；新建态是单步窄表单，维持原宽度即可。
        defaultWidth={mode === "edit" ? "70vw" : "28rem"}
        // app-no-drag：把面板 z 抬出顶部 DragRegion，头部 X 按钮才可点（Electron）
        className="app-no-drag"
      >
        {/* 错误条放在 tab 面板之外：保存/创建/MCP 提交失败时用户可能停在任一
            tab（编辑 MCP 时保存失败尤其常见），藏在某个面板里会被 hidden 挡住。 */}
        {error && (
          <div className="shrink-0 px-4 pt-3">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        )}
        {/* keep-mounted：CSS 隐藏而非卸载，切 tab 不丢编辑中状态 */}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4",
            tab !== "basic" && "hidden",
          )}
        >
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

              {/* 编辑态：tab 自管保存按钮，仍走 `form` 属性关联提交（Enter 隐式
                  提交不受影响）；新建态沿用 footer 的「创建」按钮，这里不重复。 */}
              {mode === "edit" && (
                <div className="flex justify-end pt-1">
                  <Button
                    type="submit"
                    form={AGENT_EDITOR_FORM_ID}
                    disabled={submitting}
                  >
                    {submitting && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    {submitting ? t("saving") : t("save")}
                  </Button>
                </div>
              )}
            </Form>
          )}
        </div>

        {/* 提示词 tab：新建态不存在（无 agentId 可挂载文件），只在编辑态挂载。
            keep-mounted（hidden 而非卸载）与其余 tab 一致；`min-h-0` + 内部
            自带滚动，不再套外层 overflow-y-auto（左列/正文两栏各自滚动）。 */}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-hidden",
            tab !== "prompts" && "hidden",
          )}
        >
          {mode === "edit" && formReady && localAgentId && (
            <PromptFilesEditor
              ref={promptEditorRef}
              agentId={localAgentId}
              onDirtyChange={setPromptDirty}
            />
          )}
        </div>

        {/* 技能：已装管理 + 简版市场安装（发布/详情等重功能不搬，见
            SkillManager 组件注释）。keep-mounted 靠 hidden 切换；外壳必须
            flex flex-col——工具 tab 曾因 block 外壳裁内容无滚动条踩坑，此处
            照抄同款容器写法。只在编辑态且 formReady 时挂载，与其余 tab 一致。 */}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-hidden",
            tab !== "skills" && "hidden",
          )}
        >
          {mode === "edit" && formReady && localAgentId && (
            <SkillManager agentId={localAgentId} />
          )}
        </div>

        {/* MCP 配置：受控编辑器 + 自带保存按钮（tab 自管保存，不再随基本信息
            一起提交）。只在编辑态且 formReady 时渲染，避免和加载态同屏出现
            半截 UI。 */}
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto p-4",
            tab !== "mcp" && "hidden",
          )}
        >
          {mode === "edit" && formReady && (
            <McpEditor
              value={mcpValue}
              onChange={(v) => {
                setMcpValue(v);
                setMcpError(null);
              }}
              error={mcpError}
              loading={mcpLoading}
              loadFailed={mcpLoadFailed}
              dirty={mcpValue !== mcpInitial}
              saving={mcpSaving}
              onSave={() => void handleMcpSave()}
            />
          )}
        </div>

        {/* 工具启停：分组开关 + 即时保存（tab 自管，不随 footer）。新建态不
            渲染（无 agentId 可拉 tools.json）；只在编辑态且 formReady 时挂载，
            与提示词/MCP tab 一致，keep-mounted 靠 hidden 而非卸载切换。 */}
        <div
          className={cn(
            // 必须是 flex 容器：内层 ToolPrefsEditor 靠 flex-1/min-h-0 拿高度约束
            // 才能自己滚动；block 外壳会让内层长到内容高、被 overflow-hidden 裁掉
            // 且无滚动条（真机验收反馈）。hidden 切换时 flex 被覆盖无副作用。
            "flex min-h-0 flex-1 flex-col overflow-hidden",
            tab !== "tools" && "hidden",
          )}
        >
          {mode === "edit" && formReady && localAgentId && (
            <ToolPrefsEditor agentId={localAgentId} />
          )}
        </div>
      </UnifiedSheet>

      {/* 统一的「放弃未保存修改」确认框：`pendingTab` 非空 = 切 tab 场景（确认后
          丢弃提示词当前文件的未保存改动、切到目标 tab）；为空 = 关闭整个抽屉。 */}
      <ConfirmDialog
        open={discardOpen}
        title={t("discardTitle")}
        description={t("discardDescription")}
        confirmText={t("discardConfirm")}
        cancelText={t("discardCancel")}
        destructive
        onConfirm={() => {
          setDiscardOpen(false);
          if (pendingTab) {
            promptEditorRef.current?.discardDirty();
            setTab(pendingTab);
            setPendingTab(null);
          } else {
            onOpenChange(false);
          }
        }}
        onCancel={() => {
          setDiscardOpen(false);
          setPendingTab(null);
        }}
      />
    </>
  );
}
