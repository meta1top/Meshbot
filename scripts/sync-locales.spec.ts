// scripts/sync-locales.spec.ts
import { Project, type SourceFile } from "ts-morph";
import { collectUsedKeysFromFile, diff, flatten } from "./sync-locales";

/** 用一段源码文本创建内存 SourceFile，供 collectUsedKeysFromFile 测试喂固件。 */
function sourceFileFor(code: string): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile("fixture.tsx", code, { overwrite: true });
}

describe("collectUsedKeysFromFile —— 标识符→命名空间解析", () => {
  it("useTranslations(ns) 赋给变量后 t(key) → 拼成 ns.key", () => {
    const keys = collectUsedKeysFromFile(
      sourceFileFor(`const t = useTranslations("a.b"); t("c");`),
    );
    expect(keys.has("a.b.c")).toBe(true);
    // useTranslations 首参本身也按 namespace 前缀收集（既有行为保留）
    expect(keys.has("a.b")).toBe(true);
  });

  it("await getTranslations(ns) 变体（服务端组件常见写法）同样拼接命名空间", () => {
    const keys = collectUsedKeysFromFile(
      sourceFileFor(
        `async function Page() { const t = await getTranslations("a.b"); t("c"); }`,
      ),
    );
    expect(keys.has("a.b.c")).toBe(true);
  });

  it("useTranslations() 无命名空间参数 → t(key) 原样透传（key 本身已是完整路径）", () => {
    const keys = collectUsedKeysFromFile(
      sourceFileFor(`const t = useTranslations(); t("x.y");`),
    );
    expect(keys.has("x.y")).toBe(true);
  });

  it("非 t 的重命名变量（如 tNav）可解析时同样正确拼接命名空间", () => {
    const keys = collectUsedKeysFromFile(
      sourceFileFor(
        `const tNav = useTranslations("moreSidebar"); tNav("home");`,
      ),
    );
    expect(keys.has("moreSidebar.home")).toBe(true);
  });

  it("标识符 t 解析不到声明（如作为函数参数透传）→ 退回收裸键（历史行为，避免回归）", () => {
    const keys = collectUsedKeysFromFile(
      sourceFileFor(`function f(t: any) { t("bareKey"); }`),
    );
    expect(keys.has("bareKey")).toBe(true);
  });

  it("非 t 的标识符解析不到声明 → 跳过，不收裸键（避免把无关调用误判为翻译键）", () => {
    const keys = collectUsedKeysFromFile(
      sourceFileFor(`function f(tNav: any) { tNav("shouldNotCollect"); }`),
    );
    expect(keys.has("shouldNotCollect")).toBe(false);
  });

  it("let 声明后被重新赋值 → 视为不可解析，t(key) 退回裸键", () => {
    const keys = collectUsedKeysFromFile(
      sourceFileFor(
        `let t = useTranslations("ns"); t = (window as any).other; t("z");`,
      ),
    );
    expect(keys.has("z")).toBe(true);
    expect(keys.has("ns.z")).toBe(false);
  });

  it("动态 namespace 参数（非字符串字面量）→ 不可解析，t(key) 退回裸键", () => {
    const keys = collectUsedKeysFromFile(
      sourceFileFor(
        `declare const nsVar: string; const t = useTranslations(nsVar); t("x");`,
      ),
    );
    expect(keys.has("x")).toBe(true);
    expect([...keys].some((k) => k.endsWith(".x") && k !== "x")).toBe(false);
  });

  it("服务端 xxx.translate(字面量) 属性访问路径不受影响：原样收集完整 key", () => {
    const keys = collectUsedKeysFromFile(
      sourceFileFor(`i18n.translate("common.ok", { lang, args });`),
    );
    expect(keys.has("common.ok")).toBe(true);
  });

  it("服务端 xxx.translate(动态变量) 不产生新 key（现状：动态 key 跳过，不回归）", () => {
    const keys = collectUsedKeysFromFile(
      sourceFileFor(`i18n.translate(raw, { lang, args });`),
    );
    expect(keys.size).toBe(0);
  });
});

describe("diff() —— missing 判定的 fallback 边界", () => {
  it("完整路径 key 被定义 + 完整路径命中 used → 不算 missing", () => {
    const { missing } = diff(
      { app: "x", locales: { zh: flatten({ a: { b: { c: "值" } } }) } },
      new Set(["a.b.c"]),
    );
    expect(missing).not.toContain("a.b.c");
    expect(missing.length).toBe(0);
  });

  it("只有 a.b.c 被定义，used 里却是解析失败退回的裸键 c → 仍判 missing（记录 fallback 边界）", () => {
    const { missing } = diff(
      { app: "x", locales: { zh: flatten({ a: { b: { c: "值" } } }) } },
      new Set(["c"]),
    );
    expect(missing).toContain("c");
  });
});
