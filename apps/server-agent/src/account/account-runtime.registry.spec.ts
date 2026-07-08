import { AccountContextService } from "@meshbot/lib-agent";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { ACCOUNT_EVENTS } from "./account.events";
import { AccountRuntimeRegistry } from "./account-runtime.registry";

type StubMcp = jest.Mocked<
  Pick<
    import("@meshbot/lib-agent").McpService,
    "initAccount" | "teardownAccount"
  >
>;
type StubPrompt = jest.Mocked<
  Pick<import("@meshbot/lib-agent").PromptService, "evict">
>;
type StubRelay = jest.Mocked<
  Pick<
    import("../cloud/im-relay-client.service").ImRelayClientService,
    "connect" | "disconnect"
  >
>;

describe("AccountRuntimeRegistry", () => {
  let ctx: AccountContextService;
  let mcp: StubMcp;
  let prompt: StubPrompt;
  let relay: StubRelay;
  let emitter: EventEmitter2;
  let registry: AccountRuntimeRegistry;

  beforeEach(() => {
    ctx = new AccountContextService();

    // mcp.initAccount captures the account context at call time so we can verify
    // it was called inside ctx.run(cloudUserId, ...)
    mcp = {
      initAccount: jest.fn().mockResolvedValue(undefined),
      teardownAccount: jest.fn().mockResolvedValue(undefined),
    };

    prompt = { evict: jest.fn() };
    relay = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    };
    emitter = new EventEmitter2();
    jest.spyOn(emitter, "emit");

    registry = new AccountRuntimeRegistry(
      ctx,
      mcp as unknown as import("@meshbot/lib-agent").McpService,
      prompt as unknown as import("@meshbot/lib-agent").PromptService,
      relay as unknown as import("../cloud/im-relay-client.service").ImRelayClientService,
      emitter,
    );
  });

  describe("createRuntime", () => {
    it("mcp.initAccount(u1) が呼ばれ、かつアカウントコンテキスト内で呼ばれること", async () => {
      let capturedContext: string | null = null;
      mcp.initAccount.mockImplementation(async () => {
        capturedContext = ctx.get();
      });

      await registry.createRuntime("u1");

      expect(mcp.initAccount).toHaveBeenCalledWith("u1");
      expect(capturedContext).toBe("u1");
    });

    it("relay.connect(u1) が呼ばれること", async () => {
      await registry.createRuntime("u1");

      expect(relay.connect).toHaveBeenCalledWith("u1");
    });

    it("createRuntime後にhas(u1)がtrueになること", async () => {
      await registry.createRuntime("u1");

      expect(registry.has("u1")).toBe(true);
    });

    it("createRuntime後に runtimeCreated イベントが cloudUserId 付きで発火すること", async () => {
      await registry.createRuntime("u1");

      expect(emitter.emit).toHaveBeenCalledWith(ACCOUNT_EVENTS.runtimeCreated, {
        cloudUserId: "u1",
      });
    });
  });

  describe("teardownRuntime", () => {
    it("mcp.teardownAccount / prompt.evict / relay.disconnect が呼ばれること", async () => {
      await registry.createRuntime("u1");
      await registry.teardownRuntime("u1");

      expect(mcp.teardownAccount).toHaveBeenCalledWith("u1");
      expect(prompt.evict).toHaveBeenCalledWith("u1");
      expect(relay.disconnect).toHaveBeenCalledWith("u1");
    });

    it("teardownRuntime後にhas(u1)がfalseになること", async () => {
      await registry.createRuntime("u1");
      await registry.teardownRuntime("u1");

      expect(registry.has("u1")).toBe(false);
    });

    it("teardownRuntime後に runtimeTeardown イベントが cloudUserId 付きで発火すること", async () => {
      await registry.teardownRuntime("u1");

      expect(emitter.emit).toHaveBeenCalledWith(
        ACCOUNT_EVENTS.runtimeTeardown,
        {
          cloudUserId: "u1",
        },
      );
    });
  });

  describe("createRuntime is idempotent (calling twice tears down first)", () => {
    it("2回呼び出しでもエラーにならず、teardownが先に走ること", async () => {
      await registry.createRuntime("u1");
      await registry.createRuntime("u1");

      // teardownAccount should have been called at least once (on the second createRuntime)
      expect(mcp.teardownAccount).toHaveBeenCalledWith("u1");
      // relay.connect should have been called twice total
      expect(relay.connect).toHaveBeenCalledTimes(2);
      // Still live after second create
      expect(registry.has("u1")).toBe(true);
    });
  });

  describe("reloadRuntime", () => {
    it("teardown + create の順で動くこと", async () => {
      const calls: string[] = [];
      mcp.teardownAccount.mockImplementation(async () => {
        calls.push("teardown");
      });
      mcp.initAccount.mockImplementation(async () => {
        calls.push("initAccount");
      });
      relay.connect.mockImplementation(async () => {
        calls.push("connect");
      });
      relay.disconnect.mockImplementation(() => {
        calls.push("disconnect");
      });

      await registry.reloadRuntime("u1");

      // teardown (mcp.teardownAccount + relay.disconnect) runs first inside createRuntime,
      // then mcp.initAccount (inside ctx.run), then relay.connect
      expect(calls).toEqual([
        "teardown",
        "disconnect",
        "initAccount",
        "connect",
      ]);
      expect(registry.has("u1")).toBe(true);
    });
  });
});
