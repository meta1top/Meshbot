/**
 * `next-intl` 测试桩。
 *
 * `SessionTree` 本体禁止依赖 next-intl（见 session-tree.tsx 顶部注释），但它经
 * `@meshbot/design` 的桶装 `index.ts` 传递引入 `sheet.tsx`（用了
 * `useTranslations`）——next-intl 是纯 ESM 包，ts-jest 默认不转译
 * `node_modules` 下的 ESM 语法会直接报 `Unexpected token 'export'`。
 * 这里只在 jest 里把 `next-intl` 换成不做任何事的桩，不影响真实运行时
 * （web-agent/web-main 仍用真实 next-intl provider）。
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
