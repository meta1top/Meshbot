import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PromptService } from "../../src/prompt/prompt.service";

describe("PromptService", () => {
  let testDir: string;
  let service: PromptService;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-prompt-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
    service = new PromptService(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("loads prompts from .md files", () => {
    writeFileSync(
      path.join(testDir, "prompt", "system.md"),
      "You are a helpful assistant.",
    );
    service.loadPrompts();
    expect(service.getPrompt("system")).toBe("You are a helpful assistant.");
  });

  it("returns undefined for missing prompt", () => {
    service.loadPrompts();
    expect(service.getPrompt("missing")).toBeUndefined();
  });

  it("reloads when file changes", () => {
    writeFileSync(path.join(testDir, "prompt", "system.md"), "Original.");
    service.loadPrompts();
    expect(service.getPrompt("system")).toBe("Original.");

    writeFileSync(path.join(testDir, "prompt", "system.md"), "Updated.");
    service.reloadIfChanged();
    expect(service.getPrompt("system")).toBe("Updated.");
  });
});
