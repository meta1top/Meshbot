import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccountContextService } from "../../account/account-context.service";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { SkillService } from "../../skills/skill.service";
import { SkillListTool } from "./skill-list.tool";

const ACCOUNT = "u-skill-list";
const ctx = new AccountContextService();

function makeSvc(meshbotDir: string): SkillService {
  const cfg = new MeshbotConfigService(ctx);
  (cfg as unknown as { meshbotDir: string }).meshbotDir = meshbotDir;
  return new SkillService(cfg);
}

/** skills 现按账号隔离：<root>/accounts/<account>/skills。 */
function skillsRoot(root: string): string {
  return path.join(root, "accounts", ACCOUNT, "skills");
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
    const out = await ctx.run(ACCOUNT, () => tool.execute({}, {} as never));
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
    const out = await ctx.run(ACCOUNT, () => tool.execute({}, {} as never));
    expect(JSON.parse(out)).toEqual([
      { name: "demo", description: "demo desc" },
    ]);
  });
});
