import { resolvePermission } from "./drive-acl";

const node = (over: Partial<any> = {}) =>
  ({ id: "n1", ownerUserId: "owner", orgId: "o1", ...over }) as any;
const grant = (over: Partial<any>) =>
  ({
    granteeType: "user",
    granteeId: "u1",
    permission: "viewer",
    ...over,
  }) as any;

describe("resolvePermission", () => {
  it("owner 恒为 owner（无视 grant）", () => {
    expect(
      resolvePermission({ userId: "owner", orgId: "o1" }, node(), []),
    ).toBe("owner");
  });
  it("无 grant 且非 owner → null（私有）", () => {
    expect(
      resolvePermission({ userId: "x", orgId: "o1" }, node(), []),
    ).toBeNull();
  });
  it("user grant 命中 → 该 permission", () => {
    expect(
      resolvePermission({ userId: "u1", orgId: "o1" }, node(), [
        grant({ permission: "editor" }),
      ]),
    ).toBe("editor");
  });
  it("org grant：同 org 命中", () => {
    expect(
      resolvePermission({ userId: "x", orgId: "o1" }, node(), [
        grant({ granteeType: "org", granteeId: "o1", permission: "viewer" }),
      ]),
    ).toBe("viewer");
  });
  it("org grant：异 org 不命中 → null", () => {
    expect(
      resolvePermission({ userId: "x", orgId: "oZ" }, node(), [
        grant({ granteeType: "org", granteeId: "o1" }),
      ]),
    ).toBeNull();
  });
  it("多 grant 取最高（editor > viewer）", () => {
    const gs = [
      grant({ permission: "viewer" }),
      grant({ granteeType: "org", granteeId: "o1", permission: "editor" }),
    ];
    expect(resolvePermission({ userId: "u1", orgId: "o1" }, node(), gs)).toBe(
      "editor",
    );
  });
});
