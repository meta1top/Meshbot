"use client";

import type { ModelConfigInput, ProviderDef } from "@anybot/common";
import { getAccessToken } from "@anybot/common";
import { useRouter } from "next/navigation";
import { useState } from "react";
import ModelForm from "@/components/setup/model-form";
import ProviderCard from "@/components/setup/provider-card";
import { useAuthStatus, useRegister } from "@/rest/auth";
import { useCreateModelConfig, useProviders } from "@/rest/model-config";

type SetupStep = "register" | "model";

export default function SetupPage() {
  const router = useRouter();

  const { data: authStatus, isLoading: statusLoading } = useAuthStatus();
  const { data: providers = [], isLoading: providersLoading } = useProviders();
  const registerMutation = useRegister();
  const createModelMutation = useCreateModelConfig();

  const [step, setStep] = useState<SetupStep>("register");
  const [selected, setSelected] = useState<ProviderDef | null>(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);

  if (statusLoading || providersLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-400">加载中...</p>
      </main>
    );
  }

  if (authStatus && !authStatus.needsSetup) {
    router.replace("/");
    return null;
  }

  if (authStatus?.initialized && getAccessToken()) {
    if (step === "register") {
      setStep("model");
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegisterError(null);

    if (password !== confirmPassword) {
      setRegisterError("两次输入的密码不一致");
      return;
    }

    try {
      await registerMutation.mutateAsync({ username, password });
      setStep("model");
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : "注册失败，请重试");
    }
  };

  const handleModelSubmit = async (data: ModelConfigInput) => {
    await createModelMutation.mutateAsync(data);
    router.push("/");
  };

  return (
    <main className="min-h-screen bg-gray-50 py-10">
      <div className="mx-auto max-w-lg px-4">
        <h1 className="mb-2 text-2xl font-bold text-gray-900">
          欢迎使用 Anybot
        </h1>
        <p className="mb-8 text-gray-500">
          {step === "register" ? "创建账号以开始使用" : "请配置模型以开始使用"}
        </p>

        {step === "register" && (
          <div className="rounded-xl bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-gray-700">
              创建账号
            </h2>
            <form onSubmit={handleRegister} className="flex flex-col gap-4">
              <div>
                <label
                  htmlFor="setup-username"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  用户名 <span className="text-red-500">*</span>
                </label>
                <input
                  id="setup-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label
                  htmlFor="setup-password"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  密码 <span className="text-red-500">*</span>
                </label>
                <input
                  id="setup-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label
                  htmlFor="setup-confirm-password"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  确认密码 <span className="text-red-500">*</span>
                </label>
                <input
                  id="setup-confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              {registerError && (
                <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
                  {registerError}
                </div>
              )}

              <button
                type="submit"
                disabled={
                  !username ||
                  !password ||
                  !confirmPassword ||
                  registerMutation.isPending
                }
                className="mt-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {registerMutation.isPending ? "创建中..." : "创建账号并继续"}
              </button>
            </form>
          </div>
        )}

        {step === "model" && (
          <div className="rounded-xl bg-white p-6 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">
              选择供应商
            </h2>

            <div className="mb-6 grid grid-cols-2 gap-2">
              {providers.map((p) => (
                <ProviderCard
                  key={p.type}
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
                  key={selected.type}
                  provider={selected}
                  onSubmit={handleModelSubmit}
                  submitting={createModelMutation.isPending}
                  error={
                    createModelMutation.error instanceof Error
                      ? createModelMutation.error.message
                      : createModelMutation.error
                        ? "保存失败，请重试"
                        : null
                  }
                />
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
