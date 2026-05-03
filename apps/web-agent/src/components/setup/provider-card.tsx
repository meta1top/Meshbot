"use client";

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
      onClick={onSelect}
      className={`flex flex-col gap-2 rounded-xl border-2 p-4 text-left transition-all cursor-pointer
        ${selected
          ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500"
          : "border-gray-200 hover:border-gray-300 bg-white"
        }`}
    >
      <span className="font-semibold text-gray-900">{name}</span>
      <span className="text-sm text-gray-500">{description}</span>
    </button>
  );
}
