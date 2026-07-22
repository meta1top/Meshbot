import { AccountBootstrapService } from "./account-bootstrap.service";
import type { AccountRuntimeRegistry } from "./account-runtime.registry";
import type { CloudIdentity } from "../entities/cloud-identity.entity";
import type { CloudIdentityService } from "../services/cloud-identity.service";

type StubIdentity = jest.Mocked<Pick<CloudIdentityService, "listLoggedIn">>;
type StubRuntime = jest.Mocked<Pick<AccountRuntimeRegistry, "createRuntime">>;

describe("AccountBootstrapService", () => {
  function makeService(
    loggedIn: { cloudUserId: string }[],
    createRuntime: jest.Mock,
  ) {
    const identity: StubIdentity = {
      listLoggedIn: jest
        .fn()
        .mockResolvedValue(loggedIn as unknown as CloudIdentity[]),
    };
    const runtime: StubRuntime = { createRuntime };
    return new AccountBootstrapService(
      identity as unknown as CloudIdentityService,
      runtime as unknown as AccountRuntimeRegistry,
    );
  }

  it("calls createRuntime for every logged-in account", async () => {
    const createRuntime = jest.fn().mockResolvedValue(undefined);
    const svc = makeService(
      [{ cloudUserId: "u1" }, { cloudUserId: "u2" }],
      createRuntime,
    );

    await svc.onApplicationBootstrap();

    expect(createRuntime).toHaveBeenCalledWith("u1");
    expect(createRuntime).toHaveBeenCalledWith("u2");
    expect(createRuntime).toHaveBeenCalledTimes(2);
  });

  it("continues to restore u2 even when u1 createRuntime rejects", async () => {
    const createRuntime = jest
      .fn()
      .mockRejectedValueOnce(new Error("u1 boom"))
      .mockResolvedValueOnce(undefined);
    const svc = makeService(
      [{ cloudUserId: "u1" }, { cloudUserId: "u2" }],
      createRuntime,
    );

    // must not throw
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(createRuntime).toHaveBeenCalledWith("u1");
    expect(createRuntime).toHaveBeenCalledWith("u2");
    expect(createRuntime).toHaveBeenCalledTimes(2);
  });
});
