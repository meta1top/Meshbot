import { spawn } from "node:child_process";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const BashArgsSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe("Shell command to run. Single string; can be a pipeline."),
});
type BashArgs = z.infer<typeof BashArgsSchema>;

const TIMEOUT_MS = 120_000; // 2 分钟
const CONTEXT_LIMIT = 20_000; // 给 LLM 的最终结果限 20KB
const SHELL = process.env.SHELL || "/bin/bash";

/**
 * Bash tool：在 workspace 下跑命令。
 *
 * - cwd 由 MeshbotConfigService.getWorkspaceDir() 决定
 * - stdout+stderr 合并，每段实时 emit 给前端（不截断）
 * - 给 LLM 的最终 result 截断到 20KB
 * - 120s 超时 → SIGKILL
 * - ctx.signal 触发时杀进程（用户 Stop）
 */
@Injectable()
@Tool()
export class BashTool implements MeshbotTool<BashArgs, string> {
  readonly name = "bash";
  readonly description =
    "Run a shell command in the meshbot workspace. " +
    "cwd is locked to ~/.meshbot/workspace. " +
    "Output is streamed to the user; the result you receive is the first " +
    `${CONTEXT_LIMIT} chars of stdout+stderr. 2-minute timeout.`;
  readonly schema = BashArgsSchema;

  constructor(private readonly config: MeshbotConfigService) {}

  async execute(args: BashArgs, ctx: ToolContext): Promise<string> {
    const cwd = this.config.getWorkspaceDir();
    return new Promise<string>((resolve, reject) => {
      const buf: string[] = [];
      let bufLen = 0;
      let totalLen = 0;
      let truncated = false;
      const child = spawn(SHELL, ["-lc", args.command], {
        cwd,
        env: { ...process.env, PWD: cwd },
        signal: ctx.signal,
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, TIMEOUT_MS);
      const onData = (chunk: Buffer): void => {
        const s = chunk.toString("utf8");
        totalLen += s.length;
        ctx.emitter.emit(SESSION_WS_EVENTS.runToolCallProgress, {
          sessionId: ctx.sessionId,
          toolCallId: ctx.toolCallId,
          delta: s,
        });
        if (!truncated) {
          if (bufLen + s.length <= CONTEXT_LIMIT) {
            buf.push(s);
            bufLen += s.length;
          } else {
            const room = CONTEXT_LIMIT - bufLen;
            if (room > 0) buf.push(s.slice(0, room));
            bufLen = CONTEXT_LIMIT;
            truncated = true;
          }
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        // AbortError：signal 触发导致 spawn 报错，当作 exit null 处理（close 可能不再触发）
        if (
          err.name === "AbortError" ||
          (err as { code?: string }).code === "ABORT_ERR"
        ) {
          const head = `[exit null] cwd=${cwd}\n`;
          resolve(head);
        } else {
          reject(err);
        }
      });
      child.on("close", (code, sig) => {
        clearTimeout(timer);
        const exitTag = sig
          ? `signal:${sig}`
          : code === null
            ? "null"
            : String(code);
        const head =
          `[exit ${exitTag}] cwd=${cwd}\n` +
          (truncated
            ? `[output truncated at ${CONTEXT_LIMIT} chars; total ${totalLen}]\n`
            : "");
        resolve(head + buf.join(""));
      });
    });
  }
}
