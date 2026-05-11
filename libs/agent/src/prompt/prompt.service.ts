import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import type { PromptMap } from "./prompt.types";

@Injectable()
export class PromptService {
  private prompts: PromptMap = new Map();
  private promptDir: string;

  constructor(meshbotDir: string) {
    this.promptDir = path.join(meshbotDir, "prompt");
    this.loadPrompts();
  }

  loadPrompts(): void {
    if (!existsSync(this.promptDir)) {
      this.prompts = new Map();
      return;
    }

    const files = readdirSync(this.promptDir).filter((f) => f.endsWith(".md"));
    const newPrompts: PromptMap = new Map();

    for (const file of files) {
      const filePath = path.join(this.promptDir, file);
      const name = path.basename(file, ".md");
      const content = readFileSync(filePath, "utf8");
      const stats = statSync(filePath);
      newPrompts.set(name, { content, mtime: stats.mtimeMs });
    }

    this.prompts = newPrompts;
  }

  getPrompt(name: string): string | undefined {
    return this.prompts.get(name)?.content;
  }

  getAllPrompts(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [name, entry] of this.prompts) {
      result.set(name, entry.content);
    }
    return result;
  }

  reloadIfChanged(): void {
    if (!existsSync(this.promptDir)) return;

    const files = readdirSync(this.promptDir).filter((f) => f.endsWith(".md"));
    let hasChanges = false;

    for (const file of files) {
      const filePath = path.join(this.promptDir, file);
      const name = path.basename(file, ".md");
      const existing = this.prompts.get(name);
      const stats = statSync(filePath);

      if (!existing || existing.mtime !== stats.mtimeMs) {
        hasChanges = true;
        break;
      }
    }

    if (hasChanges || files.length !== this.prompts.size) {
      this.loadPrompts();
    }
  }
}
