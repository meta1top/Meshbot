"use client";

import { cn } from "@anybot/design";

interface BrandLayoutProps {
  children: React.ReactNode;
  className?: string;
}

export function BrandLayout({ children, className }: BrandLayoutProps) {
  return (
    <div className="flex min-h-screen">
      <div className="hidden lg:flex lg:w-[480px] xl:w-[560px] flex-col justify-between bg-linear-to-br from-gray-900 via-gray-800 to-gray-900 p-10 text-white relative overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute -top-24 -left-24 h-96 w-96 rounded-full bg-white/20 blur-3xl" />
          <div className="absolute bottom-0 right-0 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
          <svg
            className="absolute inset-0 h-full w-full"
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-hidden="true"
          >
            <defs>
              <pattern
                id="grid"
                width="40"
                height="40"
                patternUnits="userSpaceOnUse"
              >
                <path
                  d="M 40 0 L 0 0 0 40"
                  fill="none"
                  stroke="white"
                  strokeWidth="0.5"
                  opacity="0.3"
                />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid)" />
          </svg>
        </div>

        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-16 mt-4">
            <div className="h-10 w-10 rounded-xl bg-white/20 backdrop-blur flex items-center justify-center">
              <span className="text-lg font-bold">A</span>
            </div>
            <span className="text-xl font-bold tracking-tight">Anybot</span>
          </div>

          <h1 className="text-3xl font-bold leading-tight mb-4">
            你的智能 AI Agent
            <br />
            随时待命
          </h1>
          <p className="text-white/60 text-base leading-relaxed max-w-sm">
            Anybot 帮助你管理和运行 AI Agent，无论是本地还是云端，一切尽在掌控。
          </p>
        </div>

        <p className="relative z-10 text-sm text-white/40">
          Anybot &copy; {new Date().getFullYear()}
        </p>
      </div>

      <div
        className={cn(
          "flex flex-1 flex-col items-center justify-center p-6 sm:p-10",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
