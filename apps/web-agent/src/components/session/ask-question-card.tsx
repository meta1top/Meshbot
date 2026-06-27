"use client";

import type { AskQuestion } from "@meshbot/types-agent";
import { Check, Loader2, Send } from "lucide-react";
import { useState } from "react";
import { confirmAnswers } from "@/rest/session";
import type { ToolCallView } from "./message-list";

const OTHER = "__other__";

/** ask_question 的问题卡：每问题单/多选 + 「其他」输入，提交后解锁工具。 */
export function AskQuestionCard({
  tool,
  sessionId,
}: {
  tool: ToolCallView;
  sessionId: string;
}) {
  const questions =
    ((tool.args ?? {}) as { questions?: AskQuestion[] }).questions ?? [];
  const [picks, setPicks] = useState<Record<number, Set<string>>>({});
  const [others, setOthers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  const pending = tool.status === "running";
  const result = parseStatus(tool.result);

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicks((prev) => {
      const cur = new Set(prev[qi] ?? []);
      if (multi) {
        if (cur.has(label)) {
          cur.delete(label);
        } else {
          cur.add(label);
        }
      } else {
        cur.clear();
        cur.add(label);
      }
      return { ...prev, [qi]: cur };
    });
  };

  const submit = async () => {
    setBusy(true);
    const answers = questions.map((_q, qi) => {
      const sel = [...(picks[qi] ?? [])];
      const hasOther = sel.includes(OTHER);
      const selected = sel.filter((s) => s !== OTHER);
      const other = hasOther ? others[qi]?.trim() || undefined : undefined;
      return { selected, other };
    });
    try {
      await confirmAnswers(sessionId, tool.toolCallId, answers);
    } catch {
      setBusy(false);
    }
  };

  if (!pending) {
    return (
      <div className="flex w-full items-center gap-2 rounded-[8px] border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
        <Check className="h-3 w-3" /> {terminalLabel(result)}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3 rounded-[8px] border border-border bg-muted/30 px-3 py-2">
      {questions.map((q, qi) => (
        <div key={q.question} className="flex flex-col gap-1.5">
          {q.header ? (
            <div className="text-[11px] font-semibold text-muted-foreground">
              {q.header}
            </div>
          ) : null}
          <div className="text-sm font-medium text-foreground">
            {q.question}
          </div>
          <div className="flex flex-col gap-1">
            {q.options.map((o) => (
              <Choice
                key={o.label}
                label={o.label}
                description={o.description}
                checked={picks[qi]?.has(o.label) ?? false}
                multi={q.multiSelect}
                onToggle={() => toggle(qi, o.label, q.multiSelect)}
              />
            ))}
            <Choice
              label="其他"
              checked={picks[qi]?.has(OTHER) ?? false}
              multi={q.multiSelect}
              onToggle={() => toggle(qi, OTHER, q.multiSelect)}
            />
            {picks[qi]?.has(OTHER) ? (
              <input
                value={others[qi] ?? ""}
                onChange={(e) =>
                  setOthers((p) => ({ ...p, [qi]: e.target.value }))
                }
                placeholder="自定义输入…"
                className="ml-5 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary"
              />
            ) : null}
          </div>
        </div>
      ))}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Send className="h-3 w-3" />
          )}{" "}
          提交
        </button>
      </div>
    </div>
  );
}

function Choice({
  label,
  description,
  checked,
  multi,
  onToggle,
}: {
  label: string;
  description?: string;
  checked: boolean;
  multi: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input
        type={multi ? "checkbox" : "radio"}
        checked={checked}
        onChange={onToggle}
        className="mt-1"
      />
      <span>
        <span className="text-foreground">{label}</span>
        {description ? (
          <span className="block text-xs text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

function parseStatus(result?: string): string | null {
  if (!result) return null;
  try {
    return (JSON.parse(result) as { status?: string }).status ?? null;
  } catch {
    return null;
  }
}

function terminalLabel(status: string | null): string {
  switch (status) {
    case "answered":
      return "已提交";
    case "timeout":
      return "未回答（超时）";
    case "interrupted":
      return "已中断";
    default:
      return "已结束";
  }
}
