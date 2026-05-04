import * as React from "react";

import { cn } from "../../lib/utils";
import {
  buttonVariants,
  Button as UiButton,
  type ButtonProps as UiButtonProps,
} from "../ui/button";

export type ButtonProps = UiButtonProps;

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, ...props }, ref) => {
    return (
      <UiButton
        ref={ref}
        className={cn(
          "h-10 rounded-none px-4 text-[14px] font-semibold tracking-[0.01em] transition-[filter,box-shadow,background-color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring/35 focus-visible:ring-offset-0 active:brightness-95",
          className,
        )}
        {...props}
      />
    );
  },
);

Button.displayName = "AppleButton";

export { Button, buttonVariants };
