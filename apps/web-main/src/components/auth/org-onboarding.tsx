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
  cn,
  Input,
} from "@meshbot/design";
import { Form, FormItem } from "@meshbot/design/form";
import { useSchema } from "@meshbot/design/hooks";
import {
  type AcceptInvitationInput,
  AcceptInvitationSchema,
  type CreateOrgInput,
  CreateOrgSchema,
} from "@meshbot/types-main";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { useAcceptInvitation, useCreateOrg } from "@/rest/org";

type Mode = "create" | "join";

/**
 * `/authorize` 无组织引导：已登录但 `profile.activeOrg == null` 时渲染，
 * 提供「建组织」/「粘贴邀请码」两个入口（并排卡片切换，非独立路由）。
 * 任一成功后调用方（父页面）靠 profile invalidate 自动重新渲染确认卡片，
 * 此组件不自行处理"成功后"跳转。
 */
export function OrgOnboarding() {
  const t = useTranslations("authorize");
  const [mode, setMode] = useState<Mode>("create");

  const createOrgMutation = useCreateOrg();
  const acceptInvitationMutation = useAcceptInvitation();
  const createOrgSchema = useSchema(CreateOrgSchema);
  const acceptInvitationSchema = useSchema(AcceptInvitationSchema);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onCreateOrg = async (values: CreateOrgInput) => {
    setErrorMessage(null);
    try {
      await createOrgMutation.mutateAsync(values);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError ? err.message : t("onboarding.createFailed"),
      );
    }
  };

  const onAcceptInvitation = async (values: AcceptInvitationInput) => {
    setErrorMessage(null);
    try {
      await acceptInvitationMutation.mutateAsync(values);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError ? err.message : t("onboarding.joinFailed"),
      );
    }
  };

  return (
    <Card className="w-full max-w-[420px] border-0 shadow-none">
      <CardHeader className="space-y-1">
        <CardTitle>{t("onboarding.title")}</CardTitle>
        <CardDescription>{t("onboarding.description")}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {/* 模式切换：建组织 / 粘贴邀请码 */}
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-md bg-muted p-1">
          <button
            type="button"
            onClick={() => {
              setMode("create");
              setErrorMessage(null);
            }}
            className={cn(
              "rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
              mode === "create"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t("onboarding.createTab")}
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("join");
              setErrorMessage(null);
            }}
            className={cn(
              "rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
              mode === "join"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t("onboarding.joinTab")}
          </button>
        </div>

        {mode === "create" ? (
          <Form
            schema={createOrgSchema}
            defaultValues={{ name: "" }}
            onSubmit={onCreateOrg}
            className="flex flex-col gap-4"
          >
            <FormItem name="name" label={t("onboarding.orgName")}>
              <Input placeholder={t("onboarding.orgNamePlaceholder")} />
            </FormItem>

            {errorMessage && (
              <Alert variant="destructive">
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" disabled={createOrgMutation.isPending}>
              {createOrgMutation.isPending
                ? t("onboarding.creating")
                : t("onboarding.create")}
            </Button>
          </Form>
        ) : (
          <Form
            schema={acceptInvitationSchema}
            defaultValues={{ token: "" }}
            onSubmit={onAcceptInvitation}
            className="flex flex-col gap-4"
          >
            <FormItem name="token" label={t("onboarding.inviteToken")}>
              <Input placeholder={t("onboarding.inviteTokenPlaceholder")} />
            </FormItem>

            {errorMessage && (
              <Alert variant="destructive">
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" disabled={acceptInvitationMutation.isPending}>
              {acceptInvitationMutation.isPending
                ? t("onboarding.joining")
                : t("onboarding.join")}
            </Button>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}
