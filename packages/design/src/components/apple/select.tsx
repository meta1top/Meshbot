"use client";

import * as React from "react";

import { cn } from "../../lib/utils";
import {
  Select,
  SelectGroup,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectValue,
  SelectContent as UiSelectContent,
  SelectItem as UiSelectItem,
  SelectTrigger as UiSelectTrigger,
} from "../ui/select";

type SelectTriggerProps = React.ComponentProps<typeof UiSelectTrigger>;
type SelectContentProps = React.ComponentProps<typeof UiSelectContent>;
type SelectItemProps = React.ComponentProps<typeof UiSelectItem>;

const SelectTrigger = React.forwardRef<
  React.ComponentRef<typeof UiSelectTrigger>,
  SelectTriggerProps
>(({ className, ...props }, ref) => (
  <UiSelectTrigger
    ref={ref}
    className={cn(
      "h-10 rounded-none border-input bg-card text-[14px] shadow-none transition-[border-color,box-shadow] duration-150 hover:border-muted-foreground/40 focus:ring-2 focus:ring-ring/25 focus:ring-offset-0",
      className,
    )}
    {...props}
  />
));
SelectTrigger.displayName = "AppleSelectTrigger";

const SelectContent = React.forwardRef<
  React.ComponentRef<typeof UiSelectContent>,
  SelectContentProps
>(({ className, ...props }, ref) => (
  <UiSelectContent
    ref={ref}
    className={cn(
      "rounded-none border-border bg-popover shadow-[0_8px_24px_-16px_rgba(0,0,0,0.2)] dark:shadow-[0_8px_24px_-16px_rgba(0,0,0,0.5)]",
      className,
    )}
    {...props}
  />
));
SelectContent.displayName = "AppleSelectContent";

const SelectItem = React.forwardRef<
  React.ComponentRef<typeof UiSelectItem>,
  SelectItemProps
>(({ className, ...props }, ref) => (
  <UiSelectItem
    ref={ref}
    className={cn(
      "rounded-none py-2 transition-colors focus:bg-accent",
      className,
    )}
    {...props}
  />
));
SelectItem.displayName = "AppleSelectItem";

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
