// pnpm readPackage hook。
//
// 目的：让 server-main 的 Dockerfile 可以去掉 `pnpm deploy --no-optional`。该 flag 会
// 触发 pnpm 的一个 deploy bug —— 被它排除的 optional 依赖（@pkgjs/parseargs、
// class-transformer 等）仍被解析图引用 → ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY。
//
// 去掉 --no-optional 后，为避免把 typeorm 列为 optional peer 的一堆无关数据库驱动
// （尤其 better-sqlite3，需 native 编译，而 server-main 是 Postgres）拉进镜像，这里
// 剥离 typeorm 的这些 optional peer 驱动声明。各 app 直接声明真正用到的驱动
// （server-main→pg、server-agent→better-sqlite3），typeorm 运行期按需 require 即可，
// 不依赖这些 peer 声明。
const TYPEORM_OPTIONAL_DRIVERS = [
  "better-sqlite3",
  "sqlite3",
  "mysql",
  "mysql2",
  "oracledb",
  "mssql",
  "mongodb",
  "redis",
  "ioredis",
  "sql.js",
  "@sap/hana-client",
  "@google-cloud/spanner",
  "pg",
  "pg-native",
  "pg-query-stream",
  "hdb-pool",
  "typeorm-aurora-data-api-driver",
];

function readPackage(pkg) {
  if (pkg.name === "typeorm") {
    for (const driver of TYPEORM_OPTIONAL_DRIVERS) {
      if (pkg.peerDependencies) delete pkg.peerDependencies[driver];
      if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[driver];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
