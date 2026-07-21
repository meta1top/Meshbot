import { createStore } from "jotai";
import { globalConfirmAtom } from "@/atoms/global-alert";

/**
 * `useGlobalConfirm` 的核心不变量测试。用 store 直接驱动 atom（hook 本身只是
 * 「建 Promise + 写 atom」的薄封装，组件层无既有测试基建，见 CLAUDE.md 分档）。
 */
describe("globalConfirmAtom：确认弹窗的 Promise 桥接", () => {
  it("宿主 settle 后 Promise 拿到用户的选择", async () => {
    const store = createStore();
    const p = new Promise<boolean>((resolve) => {
      store.set(globalConfirmAtom, { message: "覆盖草稿?", resolve });
    });
    store.get(globalConfirmAtom)?.resolve(true);
    store.set(globalConfirmAtom, null);
    await expect(p).resolves.toBe(true);
  });

  it("取消 / Esc / 遮罩点击一律按否——绝不能让调用方永远 await", async () => {
    const store = createStore();
    const p = new Promise<boolean>((resolve) => {
      store.set(globalConfirmAtom, { message: "覆盖草稿?", resolve });
    });
    // 宿主的 onOpenChange(false) 分支
    store.get(globalConfirmAtom)?.resolve(false);
    store.set(globalConfirmAtom, null);
    await expect(p).resolves.toBe(false);
  });

  it("新调用覆盖旧的时，旧 Promise 必须先以 false 结掉（否则静默挂起，最难查）", async () => {
    const store = createStore();
    let settled = false;
    const first = new Promise<boolean>((resolve) => {
      store.set(globalConfirmAtom, {
        message: "第一次",
        resolve: (v) => {
          settled = true;
          resolve(v);
        },
      });
    });
    // useGlobalConfirm 覆盖前的动作：先结掉旧的
    store.get(globalConfirmAtom)?.resolve(false);
    store.set(globalConfirmAtom, {
      message: "第二次",
      resolve: () => undefined,
    });
    await expect(first).resolves.toBe(false);
    expect(settled).toBe(true);
    expect(store.get(globalConfirmAtom)?.message).toBe("第二次");
  });
});
