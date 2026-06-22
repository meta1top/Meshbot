// scripts/check-dev-script.spec.ts
import { type PkgInfo, runDevScriptCheck } from "./check-dev-script";

/** dist 产物消费型依赖包，含 dev —— 合规 */
const LIB_OK: PkgInfo = {
  name: "@meshbot/assets",
  pkg: {
    name: "@meshbot/assets",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    scripts: { build: "tsc", dev: "tsc --watch" },
  },
};

/** dist 产物消费型依赖包，缺 dev —— 违规（assets 事故复现） */
const LIB_MISSING_DEV: PkgInfo = {
  name: "@meshbot/assets",
  pkg: {
    name: "@meshbot/assets",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    scripts: { build: "tsc" },
  },
};

/** 消费方，依赖上面的 lib */
const CONSUMER: PkgInfo = {
  name: "@meshbot/main",
  pkg: {
    name: "@meshbot/main",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    scripts: { build: "tsc", dev: "tsc --watch" },
    dependencies: { "@meshbot/assets": "workspace:*" },
  },
};

/** 源码消费型包（入口指向 src），缺 dev 也合规 —— design 豁免 */
const SOURCE_PKG: PkgInfo = {
  name: "@meshbot/design",
  pkg: {
    name: "@meshbot/design",
    main: "./src/index.ts",
    types: "./src/index.ts",
    scripts: { build: "echo no build needed" },
  },
};

const SOURCE_CONSUMER: PkgInfo = {
  name: "@meshbot/web-agent",
  pkg: {
    name: "@meshbot/web-agent",
    scripts: { dev: "next dev" },
    dependencies: { "@meshbot/design": "workspace:*" },
  },
};

describe("runDevScriptCheck", () => {
  it("dist 产物依赖包齐全 dev → 无违规", () => {
    const v = runDevScriptCheck([LIB_OK, CONSUMER]);
    expect(v).toHaveLength(0);
  });

  it("dist 产物依赖包缺 dev → 违规（assets 事故）", () => {
    const v = runDevScriptCheck([LIB_MISSING_DEV, CONSUMER]);
    expect(v).toHaveLength(1);
    expect(v[0].name).toBe("@meshbot/assets");
    expect(v[0].reason).toContain("@meshbot/main");
  });

  it("源码消费型包（入口 src）缺 dev → 豁免，无违规", () => {
    const v = runDevScriptCheck([SOURCE_PKG, SOURCE_CONSUMER]);
    expect(v).toHaveLength(0);
  });

  it("dist 产物包但无人依赖 → 不要求 dev（不在 watch 链路）", () => {
    const v = runDevScriptCheck([LIB_MISSING_DEV]);
    expect(v).toHaveLength(0);
  });

  it("依赖项不是 workspace 包（外部 npm 包）→ 不计入被依赖", () => {
    const consumerOfExternal: PkgInfo = {
      name: "@meshbot/main",
      pkg: {
        name: "@meshbot/main",
        scripts: { dev: "tsc --watch" },
        dependencies: { minio: "^8" },
      },
    };
    const v = runDevScriptCheck([LIB_MISSING_DEV, consumerOfExternal]);
    expect(v).toHaveLength(0);
  });
});
