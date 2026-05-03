"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import ProviderCard from "@/components/setup/provider-card";
import ModelForm from "@/components/setup/model-form";
import type { ProviderInfo, ModelConfigData, ElectronAPI } from "@/types/electron";

function getAPI(): ElectronAPI | null {
  if (typeof window !== "undefined" && window.electronAPI) {
    return window.electronAPI;
  }
  return null;
}

export default function SetupPage() {
  const router = useRouter();
  const api = getAPI();

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selected, setSelected] = useState<ProviderInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (api) {
      api.getProviders().then((list) => {
        setProviders(list);
        setLoading(false);
      });
    } else {
      setLoading(false);
    }
  }, []);

  const handleSubmit = async (data: ModelConfigData) => {
    if (!api) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.saveModelConfig(data);
      if (result.success) {
        await api.completeSetup();
        router.push("/");
      }
    } catch (err: any) {
      setError(err.message ?? "保存失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-400">加载中...</p>
      </main>
    );
  }

  if (!api) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="rounded-xl bg-white p-8 shadow-sm max-w-md text-center">
          <p className="text-gray-500">
            请在 Anybot Desktop 应用中完成初始化配置。
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50 py-10">
      <div className="mx-auto max-w-lg px-4">
        <h1 className="mb-2 text-2xl font-bold text-gray-900">
          欢迎使用 Anybot
        </h1>
        <p className="mb-8 text-gray-500">请先配置模型以开始使用</p>

        <div className="rounded-xl bg-white p-6 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">
            选择供应商
          </h2>

          <div className="mb-6 grid grid-cols-2 gap-2">
            {providers.map((p) => (
              <ProviderCard
                key={p.type}
                type={p.type}
                name={p.name}
                description={p.description}
                selected={selected?.type === p.type}
                onSelect={() => setSelected(p)}
              />
            ))}
          </div>

          {selected && (
            <>
              <div className="mb-4 border-t border-gray-100" />
              <h2 className="mb-3 text-sm font-semibold text-gray-700">
                模型配置
              </h2>
              <ModelForm
                provider={selected}
                onSubmit={handleSubmit}
                submitting={submitting}
                error={error}
              />
            </>
          )}
        </div>
      </div>
    </main>
  );
}
