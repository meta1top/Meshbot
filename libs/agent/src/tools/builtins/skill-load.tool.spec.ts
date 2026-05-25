import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { SkillService } from "../../skills/skill.service";
import { SkillLoadTool } from "./skill-load.tool";

function makeSvc(meshbotDir: string): SkillService {
  const cfg = new MeshbotConfigService();
  (cfg as unknown as { meshbotDir: string }).meshbotDir = meshbotDir;
  return new SkillService(cfg);
}

describe("SkillLoadTool", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "meshbot-skill-load-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("不存在的 skill 返 Error 字符串（提示走 skill_list）", async () => {
    const tool = new SkillLoadTool(makeSvc(tmp));
    const out = await tool.execute({ name: "missing" }, {} as never);
    expect(out).toMatch(/^Error: skill "missing" not found/);
  });

  it("非法名字（路径穿越）返 Error 字符串", async () => {
    const tool = new SkillLoadTool(makeSvc(tmp));
    const out = await tool.execute({ name: "../etc" }, {} as never);
    expect(out).toMatch(/^Error: skill /);
  });

  it("存在的 skill 返完整 SKILL.md，含 [skill dir] 头", async () => {
    const dir = path.join(tmp, "skills", "demo");
    mkdirSync(dir, { recursive: true });
    const body = "---\nname: demo\ndescription: demo desc\n---\n\n# Demo\n正文";
    writeFileSync(path.join(dir, "SKILL.md"), body);
    const tool = new SkillLoadTool(makeSvc(tmp));
    const out = await tool.execute({ name: "demo" }, {} as never);
    expect(out.startsWith(`[skill dir] ${dir}\n\n`)).toBe(true);
    expect(out.endsWith(body)).toBe(true);
  });
});
