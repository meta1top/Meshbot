"use client";

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
} from "@meshbot/design";
import { useAtomValue } from "jotai";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { currentUserAtom } from "@/atoms/auth";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { useInvitations, useInviteMember, useMembers } from "@/rest/org";

export default function OrgSettingsPage() {
  const t = useTranslations("orgSettings");
  const user = useAtomValue(currentUserAtom);
  const org = user?.org ?? null;
  const isOwner = org?.role === "owner";

  const { data: members = [] } = useMembers(org?.id ?? null);
  const { data: invitations = [] } = useInvitations(org?.id ?? null, isOwner);
  const invite = useInviteMember(org?.id ?? "");
  const [email, setEmail] = useState("");

  const onInvite = async () => {
    if (!email) return;
    try {
      await invite.mutateAsync(email);
      setEmail("");
    } catch {
      // 错误通过 invite.error 展示
    }
  };

  if (!org) {
    return (
      <AppShellLayout>
        <div className="p-6 text-sm text-muted-foreground">{t("noOrg")}</div>
      </AppShellLayout>
    );
  }

  return (
    <AppShellLayout>
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("membersTitle", { org: org.name })}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {members.map((m) => (
              <div
                key={m.userId}
                className="flex items-center justify-between border-b border-border py-2 text-sm last:border-0"
              >
                <span>
                  {m.displayName}{" "}
                  <span className="text-muted-foreground">({m.email})</span>
                </span>
                <span className="text-xs text-muted-foreground">{m.role}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {isOwner ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("inviteTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex gap-2">
                <Input
                  type="email"
                  placeholder={t("invitePlaceholder")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Button onClick={onInvite} disabled={invite.isPending}>
                  {invite.isPending ? t("inviting") : t("invite")}
                </Button>
              </div>
              {invite.error ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {invite.error instanceof Error
                      ? invite.error.message
                      : t("inviteFailed")}
                  </AlertDescription>
                </Alert>
              ) : null}
              {invitations.length > 0 ? (
                <div className="flex flex-col gap-1 pt-2">
                  <p className="text-xs font-semibold text-muted-foreground">
                    {t("pendingTitle")}
                  </p>
                  {invitations.map((inv) => (
                    <div
                      key={inv.id}
                      className="flex items-center justify-between py-1 text-sm"
                    >
                      <span>{inv.email}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {t("code")}: {inv.token}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </AppShellLayout>
  );
}
