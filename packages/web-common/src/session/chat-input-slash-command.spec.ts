import {
  computeSlashMenu,
  matchSlashCommand,
  type SlashCommand,
} from "./chat-input";

/**
 * `/` 命令发送拦截的判定逻辑（`ChatInput.handleSend` 里唯一的分支依据）。
 *
 * 抽成纯函数单测，绕开 tiptap 编辑器在 jsdom 下不便驱动的问题——仓库里
 * 目前没有对 chat-input.tsx 做过 RTL 渲染测试的先例（tiptap/ProseMirror
 * 依赖的浏览器 Selection/Range API 在 jsdom 下支持不完整）。三个必测场景：
 * 命中已注册命令 / 未命中已注册命令（未知命令）/ 未传 commands 时按现状
 * 正常发送（"none"，调用方据此照旧调 onSend，不做任何拦截）。
 */

function makeCompactCommand(
  overrides: Partial<SlashCommand> = {},
): SlashCommand {
  return {
    name: "compact",
    description: "压缩当前会话上下文",
    run: async () => undefined,
    ...overrides,
  };
}

describe("matchSlashCommand — 命中已注册命令", () => {
  it("首词精确匹配命令名 → kind='command'，带出该命令对象", () => {
    const compact = makeCompactCommand();
    const result = matchSlashCommand("/compact", [compact]);
    expect(result).toEqual({ kind: "command", command: compact });
  });

  it("命令无参数场景：首词后跟多余文本仍按首词匹配（参数解析下沉到各命令自己的 run()）", () => {
    const compact = makeCompactCommand();
    const result = matchSlashCommand("/compact 顺便清一下", [compact]);
    expect(result).toEqual({ kind: "command", command: compact });
  });

  it("首尾空白不影响匹配（trim 后判定）", () => {
    const compact = makeCompactCommand();
    const result = matchSlashCommand("  /compact  ", [compact]);
    expect(result).toEqual({ kind: "command", command: compact });
  });
});

describe("matchSlashCommand — 未命中已注册命令（未知命令）", () => {
  it("以 / 开头但首词未匹配任何命令 → kind='unknown'，带出去掉前导 / 的名字", () => {
    const compact = makeCompactCommand();
    const result = matchSlashCommand("/nope", [compact]);
    expect(result).toEqual({ kind: "unknown", name: "nope" });
  });

  it("大小写不同也算未匹配（精确匹配，不做大小写归一化）", () => {
    const compact = makeCompactCommand();
    const result = matchSlashCommand("/Compact", [compact]);
    expect(result).toEqual({ kind: "unknown", name: "Compact" });
  });
});

describe("matchSlashCommand — 未传 commands 时恒 'none'（现状行为不变）", () => {
  it("未传 commands（undefined）→ 即便文本是 /compact 也不拦截", () => {
    expect(matchSlashCommand("/compact")).toEqual({ kind: "none" });
  });

  it("commands 为空数组 → 同 undefined，不拦截", () => {
    expect(matchSlashCommand("/compact", [])).toEqual({ kind: "none" });
  });
});

describe("matchSlashCommand — 非命令文本（不以 / 开头）恒 'none'", () => {
  it("普通文本 → 'none'，照常发送", () => {
    const compact = makeCompactCommand();
    expect(matchSlashCommand("你好，帮我看看这段代码", [compact])).toEqual({
      kind: "none",
    });
  });

  it("IME 组合出的中文顿号「、」不是 ASCII '/'，不会被误判成命令前缀", () => {
    const compact = makeCompactCommand();
    expect(matchSlashCommand("、这是一句话", [compact])).toEqual({
      kind: "none",
    });
  });
});

/**
 * `/` 命令下拉菜单的触发+过滤判定（`ChatInput` 输入时实时调用，驱动菜单
 * 弹出/收起与候选项过滤）。比 `matchSlashCommand` 更严格：整个文本必须
 * 恰好是 "/" + 连续非空白字符，出现空格即视为「已经在打参数/正文」而收起。
 */
describe("computeSlashMenu — 前缀过滤", () => {
  it("/co 前缀匹配 compact → open=true，filtered 含 compact", () => {
    const compact = makeCompactCommand();
    const result = computeSlashMenu("/co", [compact]);
    expect(result).toEqual({ open: true, query: "co", filtered: [compact] });
  });

  it("单独一个 / → open=true，query 为空串，filtered 是全部命令（空前缀匹配一切）", () => {
    const compact = makeCompactCommand();
    const other = makeCompactCommand({ name: "other", description: "另一个" });
    const result = computeSlashMenu("/", [compact, other]);
    expect(result).toEqual({
      open: true,
      query: "",
      filtered: [compact, other],
    });
  });

  it("精确匹配单个命令名 → filtered 只含该命令（startsWith 对完整匹配同样成立）", () => {
    const compact = makeCompactCommand();
    const result = computeSlashMenu("/compact", [compact]);
    expect(result).toEqual({
      open: true,
      query: "compact",
      filtered: [compact],
    });
  });
});

describe("computeSlashMenu — 无匹配", () => {
  it("前缀不匹配任何命令 → open 仍为 true，但 filtered 为空数组（渲染空态行）", () => {
    const compact = makeCompactCommand();
    const result = computeSlashMenu("/xyz", [compact]);
    expect(result).toEqual({ open: true, query: "xyz", filtered: [] });
  });
});

describe("computeSlashMenu — 非 / 开头或已过首词不触发", () => {
  it("未传 commands → 恒关闭", () => {
    expect(computeSlashMenu("/co")).toEqual({
      open: false,
      query: "",
      filtered: [],
    });
  });

  it("普通文本（不以 / 开头）→ 不触发", () => {
    const compact = makeCompactCommand();
    expect(computeSlashMenu("你好", [compact])).toEqual({
      open: false,
      query: "",
      filtered: [],
    });
  });

  it("首词后已出现空格（光标已过首词，进入正文/参数）→ 收起菜单", () => {
    const compact = makeCompactCommand();
    expect(computeSlashMenu("/compact ", [compact])).toEqual({
      open: false,
      query: "",
      filtered: [],
    });
    expect(computeSlashMenu("/compact 顺便清一下", [compact])).toEqual({
      open: false,
      query: "",
      filtered: [],
    });
  });

  it("空字符串文本 → 不触发", () => {
    const compact = makeCompactCommand();
    expect(computeSlashMenu("", [compact])).toEqual({
      open: false,
      query: "",
      filtered: [],
    });
  });
});
