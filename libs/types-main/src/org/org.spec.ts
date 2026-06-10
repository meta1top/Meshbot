import {
  AcceptInvitationSchema,
  CreateInvitationSchema,
  CreateOrgSchema,
} from "./create-org.schema";

describe("org schemas", () => {
  it("CreateOrgSchema 拒绝空名、接受 1-64 字符", () => {
    expect(CreateOrgSchema.safeParse({ name: "" }).success).toBe(false);
    expect(CreateOrgSchema.safeParse({ name: "Acme" }).success).toBe(true);
    expect(CreateOrgSchema.safeParse({ name: "x".repeat(64) }).success).toBe(
      true,
    );
    expect(CreateOrgSchema.safeParse({ name: "x".repeat(65) }).success).toBe(
      false,
    );
  });

  it("CreateInvitationSchema 校验邮箱", () => {
    expect(CreateInvitationSchema.safeParse({ email: "bad" }).success).toBe(
      false,
    );
    expect(CreateInvitationSchema.safeParse({ email: "b@x.io" }).success).toBe(
      true,
    );
    expect(
      CreateInvitationSchema.safeParse({ email: `${"a".repeat(243)}@x.io` })
        .success,
    ).toBe(true);
    expect(
      CreateInvitationSchema.safeParse({ email: `${"a".repeat(251)}@x.io` })
        .success,
    ).toBe(false);
  });

  it("AcceptInvitationSchema 要求非空 token", () => {
    expect(AcceptInvitationSchema.safeParse({ token: "" }).success).toBe(false);
    expect(AcceptInvitationSchema.safeParse({ token: "abc" }).success).toBe(
      true,
    );
  });
});
