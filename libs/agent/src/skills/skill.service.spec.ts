import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { SkillService } from "./skill.service";

function makeConfig(meshbotDir: string): MeshbotConfigService {
  const cfg = new MeshbotConfigService();
  // 覆盖私有字段：测试场景下定位到临时目录。
  (cfg as unknown as { meshbotDir: string }).meshbotDir = meshbotDir;
  return cfg;
}

function writeSkill(root: string, name: string, body: string): void {
  const dir = path.join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
}

describe("SkillService", () => {
  let tmp: string;
  let svc: SkillService;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "meshbot-skill-"));
    svc = new SkillService(makeConfig(tmp));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("skills 目录不存在时 list 返空数组、load 返 null", () => {
    expect(svc.list()).toEqual([]);
    expect(svc.load("anything")).toBeNull();
  });

  it("list 解析 frontmatter 中的 name / description，按名字排序", () => {
    writeSkill(
      tmp,
      "beta",
      `---\nname: beta\ndescription: "B 技能"\n---\n\n# Beta\n正文`,
    );
    writeSkill(
      tmp,
      "alpha",
      `---\nname: alpha\ndescription: A 技能\n---\n\n# Alpha\n正文`,
    );
    const list = svc.list();
    expect(list).toEqual([
      { name: "alpha", description: "A 技能" },
      { name: "beta", description: "B 技能" },
    ]);
  });

  it("没有 SKILL.md 的子目录被跳过", () => {
    mkdirSync(path.join(tmp, "skills", "empty"), { recursive: true });
    writeSkill(tmp, "gamma", `---\nname: gamma\ndescription: G\n---\n\n正文`);
    expect(svc.list().map((e) => e.name)).toEqual(["gamma"]);
  });

  it("含特殊字符的目录名被白名单过滤（防路径穿越）", () => {
    writeSkill(
      tmp,
      "ok-name_1",
      `---\nname: ok-name_1\ndescription: ok\n---\n`,
    );
    // 模拟非法目录名
    mkdirSync(path.join(tmp, "skills", "..bad"), { recursive: true });
    writeFileSync(
      path.join(tmp, "skills", "..bad", "SKILL.md"),
      "---\nname: bad\ndescription: bad\n---\n",
    );
    expect(svc.list().map((e) => e.name)).toEqual(["ok-name_1"]);
  });

  it("load 返完整 SKILL.md 内容，包含 frontmatter 与正文", () => {
    const body = `---\nname: foo\ndescription: foo desc\n---\n\n# Foo\n这里是正文。\n`;
    writeSkill(tmp, "foo", body);
    const r = svc.load("foo");
    expect(r).not.toBeNull();
    expect(r?.name).toBe("foo");
    expect(r?.description).toBe("foo desc");
    expect(r?.content).toBe(body);
    expect(r?.dir).toBe(path.join(tmp, "skills", "foo"));
  });

  it("load 非法名字 / 不存在 skill 返 null", () => {
    expect(svc.load("../etc")).toBeNull();
    expect(svc.load("not-here")).toBeNull();
  });

  it("frontmatter description 跨行块标量 `>` 折叠为空格连接", () => {
    writeSkill(
      tmp,
      "block",
      `---\nname: block\ndescription: >\n  line one\n  line two\n---\n\n正文`,
    );
    const list = svc.list();
    expect(list[0].description).toBe("line one line two");
  });
});
