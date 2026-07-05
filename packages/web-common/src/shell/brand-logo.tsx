import { cn } from "@meshbot/design";

type BrandLogoSize = "sm" | "md" | "lg";

const SIZE = {
  sm: {
    wrap: "gap-2",
    box: "h-8 w-8",
    img: 20,
    text: "text-[16px] font-extrabold",
  },
  md: {
    wrap: "gap-2",
    box: "h-7 w-7",
    img: 18,
    text: "text-[16px] font-extrabold",
  },
  lg: {
    wrap: "gap-3",
    box: "h-11 w-11",
    img: 26,
    text: "text-[22px] font-semibold tracking-tight",
  },
} as const;

interface BrandLogoProps {
  size?: BrandLogoSize;
  /** 是否显示 MeshBot 文字（rail 仅需 mark）。 */
  withWordmark?: boolean;
  /** 加载态：白盒静止、里面的橙色 mark 自旋（用作品牌化 loading 指示器）。 */
  spinning?: boolean;
  className?: string;
}

/**
 * 统一品牌标识：深炭圆角盒 + 白色 logo mark（+ 可选 MeshBot 粗体文字）。
 * 深底 + 白 mark（img 经 brightness-0 invert 反白）在浅暖侧栏 / 启动页 / 深 rail
 * 各种背景上都清晰；文字色继承父级。spinning=true 时盒不动、仅 mark 旋转作加载指示。
 */
export function BrandLogo({
  size = "md",
  withWordmark = false,
  spinning = false,
  className,
}: BrandLogoProps) {
  const s = SIZE[size];
  return (
    <div className={cn("flex items-center", s.wrap, className)}>
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-[8px] bg-(--shell-chrome)",
          s.box,
        )}
      >
        <img
          src="/logo.svg"
          alt="MeshBot"
          width={s.img}
          height={s.img}
          className={cn(
            "brightness-0 invert",
            spinning && "animate-[spin_1.4s_linear_infinite]",
          )}
        />
      </span>
      {withWordmark && <span className={s.text}>MeshBot</span>}
    </div>
  );
}
