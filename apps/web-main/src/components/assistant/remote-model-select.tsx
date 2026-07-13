"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@meshbot/design";
import { Bot, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useModelConfigs } from "@/rest/model-config";

interface RemoteModelSelectProps {
  /** 当前组织 id（模型配置按组织下发，非当前组织无配置可选）。 */
  orgId: string;
  /** 当前选中的模型配置 id；null = 未显式选择（走对端账号默认）。 */
  value: string | null;
  onChange: (modelConfigId: string) => void;
}

/**
 * 远程会话模型选择器（web-main 版）。数据源换 `useModelConfigs(orgId)`
 * （组织级模型配置云端化，见 `@/rest/model-config`）——与 web-agent
 * `components/common/model-select.tsx` 视觉/交互对齐，数据源不同
 * （web-agent 读账号级 `ModelConfig`，本组件读组织级 `OrgModelConfigView`，
 * 两者结构上都满足 web-common `ModelConfigLike`（id/model/name），
 * 直接把 `configs` 传给 `SessionConversationView` 的 `modelConfigs` prop）。
 */
export function RemoteModelSelect({
  orgId,
  value,
  onChange,
}: RemoteModelSelectProps) {
  const t = useTranslations("session");
  const { data: configs } = useModelConfigs(orgId);
  const enabled = configs?.filter((c) => c.enabled) ?? [];
  if (enabled.length === 0) return null;

  const selected = enabled.find((c) => c.id === value) ?? enabled[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={t("modelSelect")}
          className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <Bot className="h-3.5 w-3.5" />
          <span className="max-w-[160px] truncate">{selected.name}</span>
          <ChevronRight className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        {enabled.map((c) => (
          <DropdownMenuItem
            key={c.id}
            onClick={() => onChange(c.id)}
            className="flex items-center gap-2"
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${c.id === selected.id ? "bg-[#d24a1a]" : "bg-muted-foreground/30"}`}
            />
            <span className="truncate">{c.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
