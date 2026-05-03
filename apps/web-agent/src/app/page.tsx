"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [status, setStatus] = useState<string>("检查中...");

  useEffect(() => {
    const api = window.electronAPI;
    if (api) {
      api.getSetupStatus().then((s) => {
        setStatus(s.needsSetup ? "需要配置" : "已就绪");
      });
    } else {
      setStatus("浏览器模式（未连接桌面端）");
    }
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-2xl font-bold">Anybot Agent</h1>
      <p className="ml-4 text-sm text-gray-400">{status}</p>
    </main>
  );
}
