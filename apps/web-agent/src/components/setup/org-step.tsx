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
import { useState } from "react";
import { ACCENT_BTN } from "@/lib/ui";
import { useCreateOrg, useJoinOrg } from "@/rest/org";

type Tab = "create" | "join";

/** setup 第二步：创建组织 或 粘贴邀请码加入。完成后 onDone 触发下一步。 */
export function OrgStep({ onDone }: { onDone: () => void }) {
  const t = useTranslations("setup");
  const [tab, setTab] = useState<Tab>("create");
  const createSchema = useSchema(createOrgSchema);
  const joinSchema = useSchema(joinOrgSchema);
  const createOrg = useCreateOrg();
  const joinOrg = useJoinOrg();

  const onCreate = async (values: CreateOrgInput) => {
    try {
      await createOrg.mutateAsync(values);
      onDone();
    } catch {
      // 错误通过 createOrg.error 展示
    }
  };
  const onJoin = async (values: JoinOrgInput) => {
    try {
      await joinOrg.mutateAsync(values);
      onDone();
    } catch {
      // 错误通过 joinOrg.error 展示
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
