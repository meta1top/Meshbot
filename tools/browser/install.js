#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const src = path.dirname(new URL(import.meta.url).pathname);
const base = process.env.MESHBOT_DIR || path.join(os.homedir(), ".meshbot");
const skillsDir = path.join(base, "skills");
const dest = path.join(skillsDir, "browser");

fs.mkdirSync(skillsDir, { recursive: true });
try {
  const st = fs.lstatSync(dest);
  if (st.isSymbolicLink() || st.isDirectory())
    fs.rmSync(dest, { recursive: true, force: true });
} catch {}
fs.symlinkSync(src, dest, "dir");
console.log(`[install] linked ${dest} -> ${src}`);
console.log(`skill 'browser' 已装；重启 server-agent 后 skill_list 可见。`);
