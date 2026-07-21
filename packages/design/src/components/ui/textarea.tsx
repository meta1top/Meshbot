import type * as React from "react";

import { cn } from "../../lib/utils";

/** 多行文本域（shadcn 标准形态），Agent system prompt / 长文案输入共用。 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:bg-destructive/5 aria-invalid:focus-visible:ring-destructive/30 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
