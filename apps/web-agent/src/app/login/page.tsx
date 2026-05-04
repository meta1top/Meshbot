"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuthStatus, useLogin } from "@/rest/auth";

export default function LoginPage() {
  const router = useRouter();
  const { data: authStatus, isLoading: statusLoading } = useAuthStatus();
  const loginMutation = useLogin();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  if (statusLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-400">加载中...</p>
      </main>
    );
  }

  if (authStatus?.needsSetup) {
    router.replace("/setup");
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await loginMutation.mutateAsync({ username, password });
      router.push("/");
    } catch {
      // error is available via loginMutation.error
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-center text-2xl font-bold text-gray-900">
          登录 Anybot
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label
              htmlFor="login-username"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              用户名
            </label>
            <input
              id="login-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label
              htmlFor="login-password"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              密码
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {loginMutation.error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {loginMutation.error instanceof Error
                ? loginMutation.error.message
                : "登录失败，请重试"}
            </div>
          )}

          <button
            type="submit"
            disabled={!username || !password || loginMutation.isPending}
            className="mt-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loginMutation.isPending ? "登录中..." : "登录"}
          </button>
        </form>
      </div>
    </main>
  );
}
