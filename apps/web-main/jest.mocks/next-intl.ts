/**
 * `next-intl` 测试桩。
 *
 * `session-transport.ts` 经 `@meshbot/web-common/session` 桶装 `index.ts`
 * 传递引入若干 JSX 组件（`message-list.tsx`/`artifact-body.tsx` 等），它们又
 * 经 `@meshbot/design` 的桶装导出传递引入 `next-intl`——纯 ESM 包，ts-jest
 * 默认不转译 `node_modules` 下的 ESM 语法会直接报 `Unexpected token 'export'`。
 * 这里只在 jest 里把 `next-intl` 换成不做任何事的桩，不影响真实运行时
 * （web-main 仍用真实 next-intl provider）。本文件与
 * `packages/web-common/jest.mocks/next-intl.ts` 同构，各自独立维护
 * （两个包的 jest 配置不互相依赖对方内部目录结构）。
 */
export function useTranslations() {
  return (key: string) => key;
}

export function useLocale() {
  return "zh";
}

export function useFormatter() {
  return {};
}

export function NextIntlClientProvider({ children }: { children?: unknown }) {
  return children;
}
