jest.mock("node-machine-id", () => ({ machineIdSync: jest.fn() }));
jest.mock("./meshbot-dir", () => ({ isPackaged: jest.fn() }));

import { machineIdSync } from "node-machine-id";
import { isPackaged } from "./meshbot-dir";
import { resolveMachineId } from "./machine-id";

const mockMachineId = machineIdSync as jest.Mock;
const mockIsPackaged = isPackaged as jest.Mock;

describe("resolveMachineId", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMachineId.mockReturnValue("abc123");
  });

  it("打包版返回原始 machineId", () => {
    mockIsPackaged.mockReturnValue(true);
    expect(resolveMachineId()).toBe("abc123");
  });

  it("dev 返回 dev- 前缀", () => {
    mockIsPackaged.mockReturnValue(false);
    expect(resolveMachineId()).toBe("dev-abc123");
  });

  it("采集抛错时降级为 null", () => {
    mockIsPackaged.mockReturnValue(true);
    mockMachineId.mockImplementation(() => {
      throw new Error("no machine id");
    });
    expect(resolveMachineId()).toBeNull();
  });
});
