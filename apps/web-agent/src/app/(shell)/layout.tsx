"use client";

import { useAtom } from "jotai";
import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  assistantPanelWidthAtom,
  previewArtifactAtom,
} from "@/atoms/assistant-panel";
import { ArtifactSplitPane } from "@/components/artifact/artifact-split-pane";
import { DragRegion } from "@/components/drag-region";
import { QuickAssistantFab } from "@/components/im/quick-assistant-fab";
import { SidebarSlotContext } from "@/components/shell/sidebar-slot-context";
import { WorkspaceSidebar } from "@/components/shell/workspace-sidebar";
import { useGlobalEvents } from "@/hooks/use-global-events";

function ShellInner({ children }: { children: ReactNode }) {
  const [previewArtifact, setPreviewArtifact] = useAtom(previewArtifactAtom);
  const hasArtifact = previewArtifact != null;
  useGlobalEvents();
  const [assistantWidth, setAssistantWidth] = useAtom(assistantPanelWidthAtom);
  const [isResizing, setIsResizing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  // 默认 340px；下限 380px、上限 92vw（与随手问助手同套 clamp 语义）。
  const widthStyle = `clamp(380px, ${assistantWidth}px, 92vw)`;

  /**
   * 左缘拖拽调宽。两处刻意绕开每帧开销，否则拖起来跟不上鼠标：
   *
   * 1) React 退出拖拽循环：宽度存在 ShellInner 的 jotai atom 里，每帧 setState
   *    会连同 children（整条消息流）一起重渲染。拖动期间直接写 DOM 宽度（rAF
   *    合并多次 mousemove），松手才提交一次 atom。
   * 2) 正文退出拖拽循环：产物正文是 react-markdown + rehype-highlight（大文件
   *    上万个高亮节点）甚至 iframe，宽度每帧一变就要整棵重排——这才是主要开销。
   *    拖动期间把正文冻结成「固定宽度 + 贴右缘绝对定位」：面板右缘本就不动，
   *    看起来就是让出/收回空间（变宽时左侧露出底色，变窄时左侧被裁），零重排；
   *    松手清掉内联样式，正文按最终宽度重排一次。
   *
   * 随手问助手面板一直是顺的：宽度是组件内 useState（重渲染范围只有它自己），
   * 且正文是短聊天气泡，重排本就便宜——所以它不需要这套。
   */
  const startPanelResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const avail = contentRef.current?.clientWidth ?? window.innerWidth;
      const maxW = Math.round(avail * 0.9);
      const startW = asideRef.current?.offsetWidth ?? 380;
      let latest = startW;
      let frame = 0;

      const pane = paneRef.current;
      if (pane) {
        pane.style.position = "absolute";
        pane.style.top = "0";
        pane.style.right = "0";
        pane.style.bottom = "0";
        pane.style.width = `${startW}px`;
      }

      const paint = () => {
        frame = 0;
        if (asideRef.current) asideRef.current.style.width = `${latest}px`;
      };
      const onMove = (ev: MouseEvent) => {
        latest = Math.min(Math.max(startW + (startX - ev.clientX), 380), maxW);
        // rAF 合并：mousemove 每帧可能来好几个，宽度只需写一次
        if (!frame) frame = requestAnimationFrame(paint);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (frame) cancelAnimationFrame(frame);
        document.body.style.userSelect = "";
        if (pane) {
          pane.style.position = "";
          pane.style.top = "";
          pane.style.right = "";
          pane.style.bottom = "";
          pane.style.width = "";
        }
        setIsResizing(false);
        // 只在松手时落一次 state（持久化 + 让 style prop 重新接管 clamp 表达式）
        setAssistantWidth(latest);
      };
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [setAssistantWidth],
  );

  useEffect(() => {
    document.body.classList.add("app-shell-mode");
    return () => document.body.classList.remove("app-shell-mode");
  }, []);

  // ESC 关产物分栏（随手问 FAB 自己的开关/ESC 由 FAB 自持，这里只管产物）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPreviewArtifact(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPreviewArtifact]);

  // 双栏 shell 侧栏全高贴顶,不用 titlebar-safe 空白带;顶部窗口控件避让
  // 由侧栏品牌行(mac 下移,见 globals.css .sidebar-brand)与 DragRegion 负责。
  return (
    <main className="flex h-screen flex-col bg-(--shell-content) text-foreground">
      <DragRegion />
      <div className="flex min-h-0 flex-1">
        <WorkspaceSidebar sublistSlotRef={setSlotEl} />
        <div
          ref={contentRef}
          className="relative flex min-h-0 flex-1 overflow-hidden bg-(--shell-content)"
        >
          <SidebarSlotContext.Provider value={slotEl}>
            {children}
          </SidebarSlotContext.Provider>
          {/* 产物预览：右侧全高浮层（与随手问助手同形态）；左缘拖拽调宽，
              z 抬到拖拽条（z-9999）之上 → 顶部下载/关闭按钮可点、不被 app-region:drag 吞。
              条件挂载而非常驻 + transform 滑入：合成器 transform 不触发布局变化，
              Electron 不重算 draggable regions——常驻模式下打开面板后顶部按钮的
              no-drag 洞停留在收起态快照，首次点击被拖拽区吞掉（助手面板即条件
              挂载无此问题）。挂载产生真实布局变化，regions 必然重算。 */}
          {hasArtifact && (
            <aside
              ref={asideRef}
              style={{ width: widthStyle }}
              className="app-no-drag absolute top-0 right-0 bottom-0 z-10000 flex animate-in fade-in slide-in-from-right-4 flex-col overflow-hidden border-l border-border bg-(--shell-content) shadow-[-8px_0_24px_-12px_rgba(0,0,0,0.18)] duration-200"
            >
              {/* 左缘拖拽手柄（贴内缘，避免被 overflow-hidden 裁掉） */}
              <button
                type="button"
                aria-label="resize"
                onMouseDown={startPanelResize}
                className="group absolute top-0 bottom-0 left-0 z-10 flex w-2 cursor-col-resize items-stretch"
              >
                <span className="h-full w-px bg-transparent transition-colors group-hover:bg-(--shell-accent)" />
              </button>
              {/* 正文包一层可冻结的容器：拖动期间由 startPanelResize 给它挂
                  「固定宽度 + 贴右缘绝对定位」的内联样式，避免每帧重排整棵正文。 */}
              <div ref={paneRef} className="flex min-h-0 flex-1 flex-col">
                <ArtifactSplitPane />
              </div>
            </aside>
          )}
          {isResizing && (
            <div className="fixed inset-0 z-10001 cursor-col-resize" />
          )}
          <QuickAssistantFab />
        </div>
      </div>
    </main>
  );
}

/** (shell) 段共享布局：持久骨架（sidebar/topbar/dock/resize），切 page 不 remount。 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <ShellInner>{children}</ShellInner>
    </Suspense>
  );
}
