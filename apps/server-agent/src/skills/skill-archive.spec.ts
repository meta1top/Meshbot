import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { extractToDir, findSkillRoot, packDir } from "./skill-archive";

/** 用 fflate 构造 zip Buffer。 */
function buildZip(files: Array<{ path: string; content: string }>): Buffer {
  const map: Record<string, Uint8Array> = {};
  for (const { path: p, content } of files) {
    map[p] = new TextEncoder().encode(content);
  }
  return Buffer.from(zipSync(map));
}

/**
 * 构造含恶意路径（`../` 或绝对路径）的 zip。
 * fflate `zipSync` 不清洗 entry 名，直接把恶意路径写入，模拟攻击包。
 */
function buildEvilZip(rawPath: string, content = "PWNED"): Buffer {
  return Buffer.from(zipSync({ [rawPath]: new TextEncoder().encode(content) }));
}

// ─────────────────────────────────────────────────────────────────────────────
describe("skill-archive", () => {
  let tmpDir: string;

  beforeEach(async () => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tmpDir = path.join(os.tmpdir(), `meshbot-archive-${id}`);
    await mkdir(tmpDir, { recursive: true });
  });

  // ── extractToDir 正常解包 ──────────────────────────────────────────────────
  describe("extractToDir - 正常解包", () => {
    it("解包后含 SKILL.md 的包内容正确", async () => {
      const zip = buildZip([
        { path: "SKILL.md", content: "# My Skill" },
        { path: "main.py", content: "print('hello')" },
      ]);

      const dest = path.join(tmpDir, "dest");
      await extractToDir(zip, dest);

      const md = await readFile(path.join(dest, "SKILL.md"), "utf8");
      expect(md).toBe("# My Skill");
      const py = await readFile(path.join(dest, "main.py"), "utf8");
      expect(py).toBe("print('hello')");
    });

    it("解包前清空目标目录（旧文件不残留）", async () => {
      const dest = path.join(tmpDir, "dest");
      const zip1 = buildZip([{ path: "old.txt", content: "old" }]);
      const zip2 = buildZip([{ path: "new.txt", content: "new" }]);

      await extractToDir(zip1, dest);
      await extractToDir(zip2, dest);

      await expect(stat(path.join(dest, "old.txt"))).rejects.toThrow();
      const content = await readFile(path.join(dest, "new.txt"), "utf8");
      expect(content).toBe("new");
    });
  });

  // ── extractToDir 路径穿越防护 ─────────────────────────────────────────────
  describe("extractToDir - 路径穿越防护", () => {
    it("含 ../evil 的 entry 抛 SKILL_UNSAFE_ARCHIVE，且不在 destDir 外写文件", async () => {
      const evilZip = buildEvilZip("../evil.txt");
      const dest = path.join(tmpDir, "safe");
      const evilTarget = path.join(tmpDir, "evil.txt");

      await expect(extractToDir(evilZip, dest)).rejects.toMatchObject({
        errorCode: { code: AgentErrorCode.SKILL_UNSAFE_ARCHIVE.code },
      });

      // evil.txt 不得写入 destDir 的父目录
      await expect(stat(evilTarget)).rejects.toThrow();
    });

    it("绝对路径 entry 抛 SKILL_UNSAFE_ARCHIVE", async () => {
      const evilZip = buildEvilZip("/etc/evil.txt");
      const dest = path.join(tmpDir, "safe2");

      await expect(extractToDir(evilZip, dest)).rejects.toMatchObject({
        errorCode: { code: AgentErrorCode.SKILL_UNSAFE_ARCHIVE.code },
      });
    });
  });

  // ── findSkillRoot ─────────────────────────────────────────────────────────
  describe("findSkillRoot", () => {
    it("SKILL.md 在根目录 → 返回 '.'", async () => {
      const zip = buildZip([
        { path: "SKILL.md", content: "# root" },
        { path: "index.ts", content: "" },
      ]);
      expect(await findSkillRoot(zip)).toBe(".");
    });

    it("SKILL.md 在单层子目录 → 返回子目录名", async () => {
      const zip = buildZip([
        { path: "myskill/SKILL.md", content: "# sub" },
        { path: "myskill/index.ts", content: "" },
      ]);
      expect(await findSkillRoot(zip)).toBe("myskill");
    });

    it("无 SKILL.md → 返回 null", async () => {
      const zip = buildZip([
        { path: "index.ts", content: "" },
        { path: "README.md", content: "" },
      ]);
      expect(await findSkillRoot(zip)).toBeNull();
    });

    it("GitHub 格式 <repo>-main/SKILL.md → 返回 '<repo>-main'", async () => {
      const zip = buildZip([
        { path: "my-skill-main/SKILL.md", content: "# github" },
        { path: "my-skill-main/main.py", content: "" },
      ]);
      expect(await findSkillRoot(zip)).toBe("my-skill-main");
    });
  });

  // ── packDir → extractToDir 往返 ───────────────────────────────────────────
  describe("packDir → extractToDir 往返一致", () => {
    it("打包后解包内容与原始文件完全一致", async () => {
      const srcDir = path.join(tmpDir, "src");
      await mkdir(srcDir, { recursive: true });
      await writeFile(path.join(srcDir, "SKILL.md"), "# Round Trip Skill");
      await writeFile(path.join(srcDir, "tool.py"), "def run(): pass");

      const packed = await packDir(srcDir);
      expect(packed.length).toBeGreaterThan(0);

      const dest = path.join(tmpDir, "rt-dest");
      await extractToDir(packed, dest);

      expect(await readFile(path.join(dest, "SKILL.md"), "utf8")).toBe(
        "# Round Trip Skill",
      );
      expect(await readFile(path.join(dest, "tool.py"), "utf8")).toBe(
        "def run(): pass",
      );
    });
  });
});
