"use client";

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@meshbot/design";
import { AuthCard } from "@meshbot/web-common/shell";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";
import { AuthChainBanner } from "@/components/auth/auth-chain-banner";
import { AuthShell } from "@/components/auth/auth-shell";
import {
  type AuthorizeStep,
  deriveAuthorizeStep,
} from "@/components/auth/authorize-step";
import { ModelOnboarding } from "@/components/auth/model-onboarding";
import { OrgOnboarding } from "@/components/auth/org-onboarding";
import { ApiError } from "@/lib/api";
import { clearMainToken } from "@/lib/auth-storage";
import { useProfile } from "@/rest/auth";
import {
  type ApproveDeviceResult,
  useApproveDevice,
  useDeviceAuthRequest,
} from "@/rest/device-auth";
import { useModelConfigs } from "@/rest/model-config";

/** 后端「授权请求已过期」错误码（2026）；其余设备授权错误（2025 等）统一按「无效」文案兜底。 */
const DEVICE_AUTH_EXPIRED_CODE = 2026;

/**
 * 授权码 sessionStorage key。批准成功即写入（无论有无 redirectUri）：
 * loopback 重定向失败（本地端口未监听→浏览器错误页）后用户返回本页时，
 * 请求已是 approved（非 pending），靠这份缓存重新展示授权码，避免死胡同。
 */
function codeStorageKey(requestId: string): string {
  return `authorize:code:${requestId}`;
}

/** 错误 / 缺参卡片：统一样式，标题 + 说明 + 「回到桌面端重试」兜底文案。 */
function ErrorCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const t = useTranslations("authorize");
  return (
    <Card className="w-full max-w-[420px] border-0 shadow-none">
      <CardHeader className="space-y-1">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <Alert>
          <AlertDescription>{t("backToDesktop")}</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

/** 授权码展示块：等宽字体 + 复制按钮，仅 ApprovedCard 兜底态渲染。 */
function ApproveCodeBlock({ userCode }: { userCode: string }) {
  const t = useTranslations("authorize");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  /** clipboard API 可能不存在（非安全上下文）或被权限策略拒绝，失败时降级提示手动选中复制。 */
  const handleCopy = () => {
    const write = navigator.clipboard?.writeText(userCode);
    if (!write) {
      setCopyState("failed");
      return;
    }
    write
      .then(() => {
        setCopyState("copied");
        window.setTimeout(
          () => setCopyState((prev) => (prev === "copied" ? "idle" : prev)),
          2000,
        );
      })
      .catch(() => setCopyState("failed"));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
        <code className="flex-1 min-w-0 truncate font-mono text-sm text-foreground select-all">
          {userCode}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
          {copyState === "copied" ? t("approved.copied") : t("approved.copy")}
        </Button>
      </div>
      {copyState === "failed" && (
        <p className="text-xs text-destructive">{t("approved.copyManually")}</p>
      )}
    </div>
  );
}

/**
 * 「已批准」卡片：批准成功即时态与「重定向失败后返回」恢复态共用。
 * `fallback` 为 true 时（无 redirectUri 的直出兜底 / sessionStorage 恢复路径）
 * 顶部加黄提示条，告知用户 loopback 自动完成失败，需手动粘贴授权码。
 */
function ApprovedCard({
  userCode,
  fallback = false,
}: {
  userCode: string;
  fallback?: boolean;
}) {
  const t = useTranslations("authorize");
  return (
    <Card className="w-full max-w-[420px] border-0 shadow-none">
      <CardHeader className="space-y-1">
        <CardTitle>{t("approved.title")}</CardTitle>
        <CardDescription>{t("approved.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        {fallback && (
          <Alert className="border-amber-300/60 bg-amber-50 text-amber-900">
            <AlertDescription>{t("fallback.hint")}</AlertDescription>
          </Alert>
        )}
        <ApproveCodeBlock userCode={userCode} />
      </CardContent>
    </Card>
  );
}

function AuthorizeFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestId = searchParams.get("request");
  const t = useTranslations("authorize");

  const commonT = useTranslations("common");
  const profile = useProfile();
  const authenticated = profile.isSuccess && profile.data.user != null;

  const deviceAuthQuery = useDeviceAuthRequest(
    authenticated ? requestId : null,
  );
  const approveMutation = useApproveDevice();

  const [approveResult, setApproveResult] =
    useState<ApproveDeviceResult | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  // 向导「模型」步跳过标记——owner 点「跳过」也放行到确认卡（见 deriveAuthorizeStep）。
  const [modelSkipped, setModelSkipped] = useState(false);

  // 模型配置数量仅 owner 且已有组织时才需要查询（member 无写权限，直接跳到确认卡）；
  // 与 deviceAuthQuery 一样，hook 本身无条件调用，靠传参 null 关闭查询。
  const activeOrg = authenticated ? (profile.data?.activeOrg ?? null) : null;
  const ownerModelQueryEnabled =
    activeOrg != null && activeOrg.role === "owner";
  const ownerModelQuery = useModelConfigs(
    activeOrg != null && activeOrg.role === "owner" ? activeOrg.id : null,
  );

  // 未登录 / 僵尸 token（success 但 user:null，与 AuthGuard 判定一致）→ 跳登录页，
  // next 带上完整 /authorize?request=<id> 以便登录后跳回。
  useEffect(() => {
    if (profile.isPending || authenticated || !requestId) return;
    // success 但 user:null → 先清僵尸 token，防止带着无效 token 循环重定向
    if (profile.isSuccess) clearMainToken();
    const next = `/authorize?request=${encodeURIComponent(requestId)}`;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [profile.isPending, profile.isSuccess, authenticated, requestId, router]);

  // 批准成功且带 redirectUri → 尝试 loopback 重定向；重定向发起后本页即跳转离开，
  // 若跳转失败（本地端口未监听等），用户留在当前页——渲染分支已切到 spinner，
  // sessionStorage 缓存的授权码留作用户手动返回本页时的兜底恢复入口。
  useEffect(() => {
    if (!approveResult?.redirectUri || !requestId) return;
    const url = `${approveResult.redirectUri}?request=${encodeURIComponent(
      requestId,
    )}&code=${encodeURIComponent(approveResult.userCode)}`;
    window.location.href = url;
  }, [approveResult, requestId]);

  const handleApprove = async () => {
    if (!requestId) return;
    setApproveError(null);
    try {
      const result = await approveMutation.mutateAsync(requestId);
      // 先落 sessionStorage 再触发重定向 effect——重定向失败返回后仍能恢复展示授权码。
      // best-effort：sessionStorage 不可用（隐私模式/配额满）不应影响主流程，静默忽略。
      try {
        window.sessionStorage.setItem(
          codeStorageKey(requestId),
          result.userCode,
        );
      } catch {
        // 忽略——授权码兜底缓存写入失败不影响本次批准结果的展示
      }
      setApproveResult(result);
    } catch (err) {
      setApproveError(
        err instanceof ApiError ? err.message : t("confirm.approveFailed"),
      );
    }
  };

  // requestId 缺失（URL 无 ?request=）——不发任何请求，直接错误卡片。
  if (!requestId) {
    return (
      <ErrorCard
        title={t("requestMissing.title")}
        description={t("requestMissing.description")}
      />
    );
  }

  // profile 加载中 / 未登录跳转中 / 设备请求加载中 —— 统一 loading 态：卡片骨架贴近真实内容布局。
  if (profile.isPending || !authenticated || deviceAuthQuery.isPending) {
    return (
      <div
        role="status"
        aria-label={commonT("loading")}
        className="w-full max-w-[420px]"
      >
        <AuthCard className="flex flex-col gap-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-56" />
          <div className="flex gap-3 rounded-xl border border-border/60 p-3">
            <Skeleton className="h-9 w-9 rounded-lg" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-28" />
            </div>
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-10 flex-1 rounded-lg" />
            <Skeleton className="h-10 flex-1 rounded-lg" />
          </div>
        </AuthCard>
      </div>
    );
  }

  if (deviceAuthQuery.isError) {
    const err = deviceAuthQuery.error;
    const expired =
      err instanceof ApiError && err.code === DEVICE_AUTH_EXPIRED_CODE;
    // 2025（无效）与其他未知错误统一按「无效」文案兜底
    return expired ? (
      <ErrorCard
        title={t("expired.title")}
        description={t("expired.description")}
      />
    ) : (
      <ErrorCard
        title={t("invalid.title")}
        description={t("invalid.description")}
      />
    );
  }

  const request = deviceAuthQuery.data;

  // 已批准 —— 带 redirectUri：静默完成，只展示 spinner，同时上面的 effect 已发起 loopback 跳转；
  // 不带 redirectUri（罕见：请求未带回调）→ 没有 loopback 可跳，直接展示授权码兜底卡。
  if (approveResult) {
    if (approveResult.redirectUri) {
      return (
        <div className="flex flex-col items-center gap-3 py-6">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
          <p className="text-sm text-muted-foreground">{t("finishing")}</p>
        </div>
      );
    }
    return <ApprovedCard userCode={approveResult.userCode} fallback />;
  }

  // 拒绝 —— 弱化处理：灰叉圆环 + 提示可关闭页面，不调接口，请求 30 分钟自然过期。
  // 不复用 ErrorCard：拒绝后再提示「回到桌面端重新发起登录」语义矛盾。
  if (denied) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <span className="text-lg text-muted-foreground">✕</span>
        </div>
        <p className="text-sm font-semibold">{t("denied.title")}</p>
        <p className="text-xs text-muted-foreground">
          {t("denied.description")}
        </p>
      </div>
    );
  }

  // 请求存在但非 pending：先查 sessionStorage 缓存的授权码——loopback 重定向
  // 失败（浏览器错误页）返回本页时请求已是 approved，命中缓存则恢复展示授权码
  // 而非错误卡片；未命中（如另一标签页/他人处理）才提示「已处理」。
  if (request.status !== "pending") {
    const storedCode =
      typeof window === "undefined"
        ? null
        : window.sessionStorage.getItem(codeStorageKey(requestId));
    if (storedCode) {
      return <ApprovedCard userCode={storedCode} fallback />;
    }
    return (
      <ErrorCard
        title={t("alreadyProcessed.title")}
        description={t("alreadyProcessed.description")}
      />
    );
  }

  // 组织/模型/确认三步向导——deriveAuthorizeStep 统一分派：
  // 无组织 → org（OrgOnboarding）；owner 零模型未跳过 → model（ModelOnboarding）；
  // 其余（含受邀 member 直接跳过模型步）→ device（确认卡）。
  const step = deriveAuthorizeStep({
    hasOrg: activeOrg != null,
    role: activeOrg?.role ?? null,
    modelCount:
      ownerModelQuery.data?.length ?? (ownerModelQueryEnabled ? null : 0),
    modelSkipped,
  });

  return (
    <div className="w-full max-w-[420px]">
      <AuthChainBanner deviceName={request.deviceName} />
      <AuthCard>
        {step === "org" && <OrgOnboarding />}

        {step === "model" && activeOrg && (
          <ModelOnboarding
            orgId={activeOrg.id}
            onDone={() => setModelSkipped(true)}
          />
        )}

        {step === "device" && activeOrg && (
          <div>
            <div className="space-y-1 pb-3">
              <CardTitle>{t("confirm.title")}</CardTitle>
              <CardDescription>{t("confirm.subtitle")}</CardDescription>
            </div>

            {/* 设备信息结构化小卡：图标 + 设备名/平台/组织三行。 */}
            <div className="mb-4 flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3">
              <span className="text-xl leading-none" aria-hidden>
                💻
              </span>
              <div className="flex flex-col gap-0.5 text-sm">
                <p className="font-medium text-foreground">
                  {request.deviceName}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("confirm.platformLine", {
                    platform: request.platform || t("confirm.unknownPlatform"),
                  })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("confirm.orgLine", { orgName: activeOrg.name })}
                </p>
              </div>
            </div>

            {approveError && (
              <Alert variant="destructive">
                <AlertDescription>{approveError}</AlertDescription>
              </Alert>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                className="flex-1"
                disabled={approveMutation.isPending}
                onClick={() => void handleApprove()}
              >
                {approveMutation.isPending
                  ? t("confirm.approving")
                  : t("confirm.approve")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                disabled={approveMutation.isPending}
                onClick={() => setDenied(true)}
              >
                {t("confirm.deny")}
              </Button>
            </div>
          </div>
        )}
      </AuthCard>
    </div>
  );
}

/** `useSearchParams` 需要 Suspense 边界包裹，否则 Next.js 静态渲染报错。 */
export default function AuthorizePage() {
  return (
    <AuthShell>
      <Suspense fallback={null}>
        <AuthorizeFlow />
      </Suspense>
    </AuthShell>
  );
}
