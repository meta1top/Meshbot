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
} from "@meshbot/design";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";
import { AuthShell } from "@/components/auth/auth-shell";
import { OrgOnboarding } from "@/components/auth/org-onboarding";
import { ApiError } from "@/lib/api";
import { useProfile } from "@/rest/auth";
import {
  type ApproveDeviceResult,
  useApproveDevice,
  useDeviceAuthRequest,
} from "@/rest/device-auth";

/** 后端设备授权错误码——`libs/main/src/errors/main.error-codes.ts` DEVICE_AUTH_*。 */
const DEVICE_AUTH_REQUEST_INVALID_CODE = 2025;
const DEVICE_AUTH_EXPIRED_CODE = 2026;

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

/** 授权码展示块：等宽字体 + 复制按钮，批准成功后无论是否 loopback 重定向都展示，作为兜底。 */
function ApproveCodeBlock({ userCode }: { userCode: string }) {
  const t = useTranslations("authorize");
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(userCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
      <code className="flex-1 min-w-0 truncate font-mono text-sm text-foreground">
        {userCode}
      </code>
      <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
        {copied ? t("approved.copied") : t("approved.copy")}
      </Button>
    </div>
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

  // 未登录 / 僵尸 token（success 但 user:null，与 AuthGuard 判定一致）→ 跳登录页，
  // next 带上完整 /authorize?request=<id> 以便登录后跳回。
  useEffect(() => {
    if (profile.isPending || authenticated || !requestId) return;
    const next = `/authorize?request=${encodeURIComponent(requestId)}`;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [profile.isPending, authenticated, requestId, router]);

  // 批准成功且带 redirectUri → 尝试 loopback 重定向；无论成功与否，授权码块始终展示兜底。
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

  // profile 加载中 / 未登录跳转中 / 设备请求加载中 —— 统一 loading 态。
  if (profile.isPending || !authenticated || deviceAuthQuery.isPending) {
    return (
      <div
        role="status"
        aria-label={commonT("loading")}
        className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
      />
    );
  }

  if (deviceAuthQuery.isError) {
    const err = deviceAuthQuery.error;
    if (err instanceof ApiError && err.code === DEVICE_AUTH_EXPIRED_CODE) {
      return (
        <ErrorCard
          title={t("expired.title")}
          description={t("expired.description")}
        />
      );
    }
    if (
      err instanceof ApiError &&
      err.code === DEVICE_AUTH_REQUEST_INVALID_CODE
    ) {
      return (
        <ErrorCard
          title={t("invalid.title")}
          description={t("invalid.description")}
        />
      );
    }
    return (
      <ErrorCard
        title={t("invalid.title")}
        description={t("invalid.description")}
      />
    );
  }

  const request = deviceAuthQuery.data;

  // 已批准 —— 展示授权码兜底块（同时若有 redirectUri 上面的 effect 已尝试重定向）。
  if (approveResult) {
    return (
      <Card className="w-full max-w-[420px] border-0 shadow-none">
        <CardHeader className="space-y-1">
          <CardTitle>{t("approved.title")}</CardTitle>
          <CardDescription>{t("approved.description")}</CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <ApproveCodeBlock userCode={approveResult.userCode} />
        </CardContent>
      </Card>
    );
  }

  // 拒绝 —— 纯前端提示，不调接口，请求 10 分钟自然过期。
  if (denied) {
    return (
      <ErrorCard
        title={t("denied.title")}
        description={t("denied.description")}
      />
    );
  }

  // 请求存在但非 pending（如已在另一标签页处理过）—— 不再渲染确认卡片。
  if (request.status !== "pending") {
    return (
      <ErrorCard
        title={t("alreadyProcessed.title")}
        description={t("alreadyProcessed.description")}
      />
    );
  }

  // 无组织 —— 引导建组织 / 接受邀请，成功后 profile invalidate 会重新渲染到确认卡片。
  if (profile.data.activeOrg == null) {
    return <OrgOnboarding />;
  }

  // 有组织 —— 确认卡片。
  return (
    <Card className="w-full max-w-[420px] border-0 shadow-none">
      <CardHeader className="space-y-1">
        <CardTitle>{t("confirm.title")}</CardTitle>
        <CardDescription>
          {t("confirm.description", {
            deviceName: request.deviceName,
            platform: request.platform || t("confirm.unknownPlatform"),
            orgName: profile.data.activeOrg.name,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
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
      </CardContent>
    </Card>
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
