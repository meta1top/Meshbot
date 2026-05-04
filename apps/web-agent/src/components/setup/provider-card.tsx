"use client";

import { cn } from "@anybot/design";

interface ProviderCardProps {
  name: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}

export default function ProviderCard({
  name,
  description,
  selected,
  onSelect,
}: ProviderCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-2 rounded-xl border-2 p-4 text-left transition-all cursor-pointer",
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "border-border hover:border-border/80 bg-card",
      )}
    >
      <span className="font-semibold text-card-foreground">{name}</span>
      <span className="text-sm text-muted-foreground">{description}</span>
    </button>
  );
}
