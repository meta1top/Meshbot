import { AccountBootstrapService } from "./account-bootstrap.service";

describe("AccountBootstrapService", () => {
  function makeService(
    loggedIn: { cloudUserId: string }[],
    createRuntime: jest.Mock,
  ) {
    const identity = { listLoggedIn: jest.fn().mockResolvedValue(loggedIn) };
    const runtime = { createRuntime };
    return new AccountBootstrapService(identity as any, runtime as any);
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
