import { cn } from "@meshbot/design";

type BrandLogoSize = "sm" | "md" | "lg";

const SIZE = {
  sm: { wrap: "gap-2", box: "h-8 w-8", img: 20, text: "" },
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
 * 统一品牌标识：白底圆角盒 + 橙色 logo mark（+ 可选 MeshBot 文字）。
 * 白底保证 mark 在橙色品牌面板 / 深色 rail / 启动页等各种背景上对比一致；
 * 文字色继承父级（橙色面板上为白、启动页上为前景色）。
 * spinning=true 时白盒不动、仅 mark 旋转，可直接当作加载指示器。
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
          "flex shrink-0 items-center justify-center rounded-[8px] bg-white",
          s.box,
        )}
      >
        <img
          src="/logo.svg"
          alt="MeshBot"
          width={s.img}
          height={s.img}
          className={cn(spinning && "animate-[spin_1.4s_linear_infinite]")}
        />
      </span>
      {withWordmark && <span className={s.text}>MeshBot</span>}
    </div>
  );
}
