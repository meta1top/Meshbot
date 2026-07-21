import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccountContextService } from "../../account/account-context.service";
import { AgentContextService } from "../../account/agent-context.service";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { SkillService } from "../../skills/skill.service";
import { SkillListTool } from "./skill-list.tool";

const ACCOUNT = "u-skill-list";
const AGENT_ID = "agent-skill-list";
const ctx = new AccountContextService();
const agentCtx = new AgentContextService();

function makeSvc(meshbotDir: string): SkillService {
  const cfg = new MeshbotConfigService(ctx, agentCtx);
  (cfg as unknown as { meshbotDir: string }).meshbotDir = meshbotDir;
  return new SkillService(cfg);
}

/** skills 现按账号+Agent 隔离：<root>/accounts/<account>/agents/<agentId>/skills。 */
function skillsRoot(root: string): string {
  return path.join(root, "accounts", ACCOUNT, "agents", AGENT_ID, "skills");
}

/** 在账号 + Agent 双层上下文中运行 fn。 */
function runInContext<T>(fn: () => T): T {
  return ctx.run(ACCOUNT, () => agentCtx.run(AGENT_ID, fn));
}

describe("SkillListTool", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "meshbot-skill-list-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("空目录返 `[]`", async () => {
    const tool = new SkillListTool(makeSvc(tmp));
    const out = await runInContext(() => tool.execute({}, {} as never));
    expect(JSON.parse(out)).toEqual([]);
  });

  it("返 JSON 数组只含 name/description", async () => {
    const dir = path.join(skillsRoot(tmp), "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: demo\ndescription: demo desc\n---\n\n# Demo",
    );
    const tool = new SkillListTool(makeSvc(tmp));
    const out = await runInContext(() => tool.execute({}, {} as never));
    expect(JSON.parse(out)).toEqual([
      { name: "demo", description: "demo desc" },
    ]);
  });
});
