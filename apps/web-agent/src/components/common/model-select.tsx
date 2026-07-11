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

interface ModelSelectProps {
  /** 当前选中的模型配置 id；null = 未显式选择（走账号默认 = 首个 enabled）。 */
  value: string | null;
  onChange: (modelConfigId: string) => void;
  /** 触发器附加类名（不同宿主的排版差异）。 */
  className?: string;
}

/**
 * 会话模型选择器（起手台新建 + 会话页切换共用，受控）。
 * 数据源 useModelConfigs()（云端下发的只读列表）；空列表渲染 null——
 * 「未配模型」状态由 auth-guard 在更上游拦截。
 */
export function ModelSelect({ value, onChange, className }: ModelSelectProps) {
  const t = useTranslations("composer");
  const { data: configs } = useModelConfigs();
  const enabled = configs?.filter((c) => c.enabled) ?? [];
  if (enabled.length === 0) return null;

  const selected = enabled.find((c) => c.id === value) ?? enabled[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={t("modelSelect")}
          className={`flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground ${className ?? ""}`}
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
