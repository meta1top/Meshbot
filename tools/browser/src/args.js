/** 极简 argv 解析：第一个非 --flag 为 verb；--k v 取值，--k（后面是 flag 或无）为 true；重复 --k 收集成数组。 */
export function parseArgs(argv) {
  const flags = {};
  let verb;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const hasNextValue = next !== undefined && !next.startsWith("--");
      if (hasNextValue) i++;
      const value = hasNextValue ? next : true;
      if (key in flags) {
        flags[key] = Array.isArray(flags[key])
          ? [...flags[key], value]
          : [flags[key], value];
      } else {
        flags[key] = value;
      }
    } else if (verb === undefined) {
      verb = a;
    }
  }
  return { verb, flags };
}
