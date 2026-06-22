import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import * as tar from "tar";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { extractToDir, findSkillRoot, packDir } from "./skill-archive";

const gzipAsync = promisify(gzip);

/** 写临时目录再 tar.c 打包成 tar.gz Buffer。 */
async function buildTarGz(
  files: Array<{ path: string; content: string }>,
): Promise<Buffer> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpDir = path.join(os.tmpdir(), `meshbot-tarbuild-${id}`);
  await mkdir(tmpDir, { recursive: true });

  for (const { path: filePath, content } of files) {
    const fullPath = path.join(tmpDir, filePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const pack = tar.c({ gzip: true, cwd: tmpDir, preservePaths: false }, [
      ".",
    ]);
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", resolve);
    pack.on("error", reject);
  });
  return Buffer.concat(chunks);
}

/**
 * 构建含任意原始路径（含 `../` 或绝对路径）的恶意 tar.gz。
 * 直接手工构造 POSIX tar 头 + gzip 压缩，绕过 node-tar 的 preservePaths 保护。
 */
async function buildEvilTarGz(
  rawPath: string,
  content = "PWNED",
): Promise<Buffer> {
  const contentBuf = Buffer.from(content, "utf8");

  // 512-byte POSIX ustar header
  const header = Buffer.alloc(512, 0);

  // path field: bytes 0-99 (100 bytes)
  Buffer.from(rawPath, "utf8").copy(header, 0, 0, 99);
  // mode: bytes 100-107
  Buffer.from("0000644\0").copy(header, 100);
  // uid / gid: bytes 108-115, 116-123
  Buffer.from("0000000\0").copy(header, 108);
  Buffer.from("0000000\0").copy(header, 116);
  // size: bytes 124-135 (octal, null-terminated)
  Buffer.from(contentBuf.length.toString(8).padStart(11, "0") + "\0").copy(
    header,
    124,
  );
  // mtime: bytes 136-147
  Buffer.from(
    Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0") + "\0",
  ).copy(header, 136);
  // checksum placeholder: bytes 148-155 (8 spaces)
  Buffer.from("        ").copy(header, 148);
  // typeflag: byte 156 = '0' (regular file)
  header[156] = 0x30;
  // ustar magic + version
  Buffer.from("ustar\0").copy(header, 257);
  Buffer.from("00").copy(header, 263);

  // compute checksum (sum of all bytes with checksum field as spaces)
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);

  // pad content to 512-byte boundary
  const paddedLen = Math.ceil(contentBuf.length / 512) * 512;
  const contentPadded = Buffer.alloc(paddedLen, 0);
  contentBuf.copy(contentPadded);

  // end-of-archive: two 512-byte zero blocks
  const eof = Buffer.alloc(1024, 0);

  const rawTar = Buffer.concat([header, contentPadded, eof]);
  return gzipAsync(rawTar);
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
      const tarGz = await buildTarGz([
        { path: "SKILL.md", content: "# My Skill" },
        { path: "main.py", content: "print('hello')" },
      ]);

      const dest = path.join(tmpDir, "dest");
      await extractToDir(tarGz, dest);

      const md = await readFile(path.join(dest, "SKILL.md"), "utf8");
      expect(md).toBe("# My Skill");
      const py = await readFile(path.join(dest, "main.py"), "utf8");
      expect(py).toBe("print('hello')");
    });

    it("解包前清空目标目录（旧文件不残留）", async () => {
      const dest = path.join(tmpDir, "dest");
      const tarGz1 = await buildTarGz([{ path: "old.txt", content: "old" }]);
      const tarGz2 = await buildTarGz([{ path: "new.txt", content: "new" }]);

      await extractToDir(tarGz1, dest);
      await extractToDir(tarGz2, dest);

      await expect(stat(path.join(dest, "old.txt"))).rejects.toThrow();
      const content = await readFile(path.join(dest, "new.txt"), "utf8");
      expect(content).toBe("new");
    });
  });

  // ── extractToDir 路径穿越防护 ─────────────────────────────────────────────
  describe("extractToDir - 路径穿越防护", () => {
    it("含 ../evil 的 entry 抛 SKILL_UNSAFE_ARCHIVE，且不在 destDir 外写文件", async () => {
      const evilTarGz = await buildEvilTarGz("../evil.txt");
      const dest = path.join(tmpDir, "safe");
      const evilTarget = path.join(tmpDir, "evil.txt");

      await expect(extractToDir(evilTarGz, dest)).rejects.toMatchObject({
        errorCode: { code: AgentErrorCode.SKILL_UNSAFE_ARCHIVE.code },
      });

      // evil.txt 不得写入 destDir 的父目录
      await expect(stat(evilTarget)).rejects.toThrow();
    });

    it("绝对路径 entry 抛 SKILL_UNSAFE_ARCHIVE", async () => {
      const evilTarGz = await buildEvilTarGz("/etc/evil.txt");
      const dest = path.join(tmpDir, "safe2");

      await expect(extractToDir(evilTarGz, dest)).rejects.toMatchObject({
        errorCode: { code: AgentErrorCode.SKILL_UNSAFE_ARCHIVE.code },
      });
    });
  });

  // ── findSkillRoot ─────────────────────────────────────────────────────────
  describe("findSkillRoot", () => {
    it("SKILL.md 在根目录 → 返回 '.'", async () => {
      const tarGz = await buildTarGz([
        { path: "SKILL.md", content: "# root" },
        { path: "index.ts", content: "" },
      ]);
      expect(await findSkillRoot(tarGz)).toBe(".");
    });

    it("SKILL.md 在单层子目录 → 返回子目录名", async () => {
      const tarGz = await buildTarGz([
        { path: "myskill/SKILL.md", content: "# sub" },
        { path: "myskill/index.ts", content: "" },
      ]);
      expect(await findSkillRoot(tarGz)).toBe("myskill");
    });

    it("无 SKILL.md → 返回 null", async () => {
      const tarGz = await buildTarGz([
        { path: "index.ts", content: "" },
        { path: "README.md", content: "" },
      ]);
      expect(await findSkillRoot(tarGz)).toBeNull();
    });

    it("GitHub 格式 <repo>-main/SKILL.md → 返回 '<repo>-main'", async () => {
      const tarGz = await buildTarGz([
        { path: "my-skill-main/SKILL.md", content: "# github" },
        { path: "my-skill-main/main.py", content: "" },
      ]);
      expect(await findSkillRoot(tarGz)).toBe("my-skill-main");
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
