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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@meshbot/design";
import { Form, FormItem } from "@meshbot/design/form";
import { useSchema } from "@meshbot/design/hooks";
import {
  type CreateInvitationInput,
  CreateInvitationSchema,
} from "@meshbot/types-main";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ApiError } from "@/lib/api";
import { useProfile } from "@/rest/auth";
import {
  useInvitations,
  useInviteMember,
  useMembers,
  useResendInvitation,
  useRevokeInvitation,
} from "@/rest/org";

/** 组织成员管理页：成员表 + owner 专属的邀请表单 / 待处理邀请列表（重发/撤销）。 */
export default function OrgSettingsPage() {
  const t = useTranslations("orgSettings");
  const profile = useProfile();
  const activeOrg = profile.data?.activeOrg ?? null;
  const isOwner = activeOrg?.role === "owner";

  const {
    data: members = [],
    isPending: membersPending,
    error: membersError,
  } = useMembers(activeOrg?.id ?? null);
  const { data: invitations = [], isPending: invitationsPending } =
    useInvitations(activeOrg?.id ?? null, isOwner);

  const invite = useInviteMember(activeOrg?.id ?? "");
  const resend = useResendInvitation(activeOrg?.id ?? "");
  const revoke = useRevokeInvitation(activeOrg?.id ?? "");
  const inviteSchema = useSchema(CreateInvitationSchema);

  const [inviteError, setInviteError] = useState<string | null>(null);
  // Form 不暴露 reset API —— 提交成功后 key++ 强制重挂以清空输入
  const [formKey, setFormKey] = useState(0);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);

  const onInvite = async (values: CreateInvitationInput) => {
    setInviteError(null);
    try {
      await invite.mutateAsync(values);
      setFormKey((k) => k + 1);
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : t("inviteFailed"));
    }
  };

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    await revoke.mutateAsync(revokeTarget);
    setRevokeTarget(null);
  };

  if (!activeOrg) {
    return <div className="text-sm text-muted-foreground">{t("noOrg")}</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("membersTitle", { org: activeOrg.name })}</CardTitle>
        </CardHeader>
        <CardContent>
          {membersError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {membersError instanceof Error
                  ? membersError.message
                  : t("loadFailed")}
              </AlertDescription>
            </Alert>
          ) : membersPending ? (
            <div className="text-sm text-muted-foreground">{t("loading")}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colName")}</TableHead>
                  <TableHead>{t("colEmail")}</TableHead>
                  <TableHead>{t("colRole")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m.userId}>
                    <TableCell>{m.displayName}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {m.email}
                    </TableCell>
                    <TableCell>
                      {t(m.role === "owner" ? "roleOwner" : "roleMember")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {isOwner ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("inviteTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Form
              key={formKey}
              schema={inviteSchema}
              defaultValues={{ email: "" }}
              onSubmit={onInvite}
              className="flex items-start gap-2"
            >
              <FormItem name="email" className="flex-1">
                <Input type="email" placeholder={t("invitePlaceholder")} />
              </FormItem>
              <Button type="submit" disabled={invite.isPending}>
                {invite.isPending ? t("inviting") : t("invite")}
              </Button>
            </Form>
            {inviteError ? (
              <Alert variant="destructive">
                <AlertDescription>{inviteError}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-col gap-1 pt-2">
              <p className="text-xs font-semibold text-muted-foreground">
                {t("pendingTitle")}
              </p>
              {invitationsPending ? (
                <div className="text-sm text-muted-foreground">
                  {t("loading")}
                </div>
              ) : invitations.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  {t("noPending")}
                </div>
              ) : (
                <Table>
                  <TableBody>
                    {invitations.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell>{inv.email}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {t(`status.${inv.status}`)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={resend.isPending}
                              onClick={() => resend.mutate(inv.id)}
                            >
                              {t("resend")}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={revoke.isPending}
                              onClick={() => setRevokeTarget(inv.id)}
                            >
                              {t("revoke")}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <ConfirmDialog
        open={revokeTarget != null}
        title={t("revokeConfirmTitle")}
        description={t("revokeConfirmDescription")}
        confirmText={t("revoke")}
        cancelText={t("cancel")}
        loading={revoke.isPending}
        destructive
        onConfirm={() => void confirmRevoke()}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}
