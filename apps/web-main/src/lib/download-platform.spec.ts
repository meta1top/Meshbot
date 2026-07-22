import { detectPlatform } from "./download-platform";

describe("detectPlatform", () => {
  it("识别 macOS", () => {
    expect(
      detectPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      ),
    ).toBe("mac");
  });

  it("识别 Windows", () => {
    expect(
      detectPlatform(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ),
    ).toBe("win");
  });

  it("识别 Linux（且不被 Android 误判）", () => {
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });

  it("Android 不算 linux 桌面端", () => {
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe(
      "unknown",
    );
  });

  it("iPhone 归为 unknown（无桌面端产物）", () => {
    expect(
      detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"),
    ).toBe("unknown");
  });

  it("空串归为 unknown", () => {
    expect(detectPlatform("")).toBe("unknown");
  });
});
