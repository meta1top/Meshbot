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
  Input,
} from "@meshbot/design";
import { Form, FormItem } from "@meshbot/design/form";
import { useSchema } from "@meshbot/design/hooks";
import {
  type CreateOrgInput,
  createOrgSchema,
  type JoinOrgInput,
  joinOrgSchema,
} from "@meshbot/types-agent";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { ACCENT_BTN } from "@/lib/ui";
import { switchOrg, useCreateOrg, useJoinOrg } from "@/rest/org";

type Tab = "create" | "join";

/** setup 第二步：创建组织 或 粘贴邀请码加入。完成后 onDone 触发下一步。 */
export function OrgStep({ onDone }: { onDone: () => void }) {
  const t = useTranslations("setup");
  const [tab, setTab] = useState<Tab>("create");
  const createSchema = useSchema(createOrgSchema);
  const joinSchema = useSchema(joinOrgSchema);
  const createOrg = useCreateOrg();
  const joinOrg = useJoinOrg();

  // switchOrg 与 mutateAsync 分开处理原因：
  // mutateAsync（建组织/加入）一旦成功，org 已在服务端创建。此时若 switchOrg 失败（网络瞬断等），
  // 不能让用户重新触发 mutateAsync（会 NAME_CONFLICT 或重复加入）。
  // 因此用单独 state 记录"org 已建但 switchOrg 失败"的 orgId，
  // 下次点按钮时只重试 switchOrg，不重跑 mutateAsync。
  const [switchErrMsg, setSwitchErrMsg] = useState<string | null>(null);
  // 待重试的 switchOrg orgId（mutateAsync 已成功但 switchOrg 尚未成功时非 null）
  const pendingSwitchOrgId = useRef<string | null>(null);

  const onCreate = async (values: CreateOrgInput) => {
    setSwitchErrMsg(null);
    try {
      // 若上次 mutateAsync 已成功（有 pendingSwitchOrgId），跳过 mutateAsync 直接重试 switchOrg
      let orgId = pendingSwitchOrgId.current;
      if (!orgId) {
        const org = await createOrg.mutateAsync(values);
        orgId = org.id;
        pendingSwitchOrgId.current = orgId;
      }
      try {
        await switchOrg(orgId);
        pendingSwitchOrgId.current = null;
        onDone();
      } catch (switchErr) {
        // switchOrg 失败：org 已建，展示错误让用户重试（再次点按钮只会重试 switchOrg）
        setSwitchErrMsg(
          switchErr instanceof Error ? switchErr.message : t("orgSwitchFailed"),
        );
        console.error(
          "[org-step] switchOrg 失败（org 已创建，可重试）",
          switchErr,
        );
      }
    } catch {
      // 错误通过 createOrg.error 展示（mutateAsync 失败）
    }
  };
  const onJoin = async (values: JoinOrgInput) => {
    setSwitchErrMsg(null);
    try {
      // 若上次 mutateAsync 已成功（有 pendingSwitchOrgId），跳过 mutateAsync 直接重试 switchOrg
      let orgId = pendingSwitchOrgId.current;
      if (!orgId) {
        const result = await joinOrg.mutateAsync(values);
        orgId = result.orgId;
        pendingSwitchOrgId.current = orgId;
      }
      try {
        await switchOrg(orgId);
        pendingSwitchOrgId.current = null;
        onDone();
      } catch (switchErr) {
        // switchOrg 失败：已加入 org，展示错误让用户重试（再次点按钮只会重试 switchOrg）
        setSwitchErrMsg(
          switchErr instanceof Error ? switchErr.message : t("orgSwitchFailed"),
        );
        console.error(
          "[org-step] switchOrg 失败（org 已加入，可重试）",
          switchErr,
        );
      }
    } catch {
      // 错误通过 joinOrg.error 展示（mutateAsync 失败）
    }
  };

  return (
    <Card className="border-0 shadow-none">
      <CardHeader className="space-y-1">
        <CardTitle>{t("orgTitle")}</CardTitle>
        <CardDescription>{t("orgDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="pt-3">
        <div className="mb-4 flex gap-2">
          <Button
            type="button"
            variant={tab === "create" ? "default" : "outline"}
            onClick={() => setTab("create")}
          >
            {t("orgCreateTab")}
          </Button>
          <Button
            type="button"
            variant={tab === "join" ? "default" : "outline"}
            onClick={() => setTab("join")}
          >
            {t("orgJoinTab")}
          </Button>
        </div>

        {tab === "create" ? (
          <Form
            schema={createSchema}
            defaultValues={{ name: "" }}
            onSubmit={onCreate}
            className="flex flex-col gap-4"
          >
            <FormItem name="name" label={t("orgName")}>
              <Input placeholder={t("orgNamePlaceholder")} />
            </FormItem>
            {createOrg.error ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {createOrg.error instanceof Error
                    ? createOrg.error.message
                    : t("orgCreateFailed")}
                </AlertDescription>
              </Alert>
            ) : null}
            {switchErrMsg ? (
              <Alert variant="destructive">
                <AlertDescription>{switchErrMsg}</AlertDescription>
              </Alert>
            ) : null}
            <Button
              type="submit"
              className={ACCENT_BTN}
              disabled={createOrg.isPending}
            >
              {createOrg.isPending
                ? t("orgCreating")
                : t("orgCreateAndContinue")}
            </Button>
          </Form>
        ) : (
          <Form
            schema={joinSchema}
            defaultValues={{ token: "" }}
            onSubmit={onJoin}
            className="flex flex-col gap-4"
          >
            <FormItem name="token" label={t("orgInviteCode")}>
              <Input placeholder={t("orgInviteCodePlaceholder")} />
            </FormItem>
            {joinOrg.error ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {joinOrg.error instanceof Error
                    ? joinOrg.error.message
                    : t("orgJoinFailed")}
                </AlertDescription>
              </Alert>
            ) : null}
            {switchErrMsg ? (
              <Alert variant="destructive">
                <AlertDescription>{switchErrMsg}</AlertDescription>
              </Alert>
            ) : null}
            <Button
              type="submit"
              className={ACCENT_BTN}
              disabled={joinOrg.isPending}
            >
              {joinOrg.isPending ? t("orgJoining") : t("orgJoinAndContinue")}
            </Button>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}
