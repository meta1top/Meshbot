import * as React from "react";

import { cn } from "../../lib/utils";
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Card as UiCard,
} from "../ui/card";

type CardProps = React.ComponentProps<typeof UiCard>;

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, ...props }, ref) => {
    return (
      <UiCard
        ref={ref}
        className={cn(
          "rounded-lg border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.2)]",
          className,
        )}
        {...props}
      />
    );
  },
);

Card.displayName = "AppleCard";

export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
};
