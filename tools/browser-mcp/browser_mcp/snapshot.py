"""页面快照：浏览器侧 JS 采集（打 data-mb-ref）+ Python 侧精简/截断。"""
from __future__ import annotations
from typing import Any

# 给可交互+可见元素打 data-mb-ref，返回 [{ref, role, name}]；排除 presentation/none/separator 装饰元素。
COLLECT_JS = r"""
(() => {
  const INTERACTIVE = new Set(['a','button','input','textarea','select','summary']);
  const SKIP = new Set(['presentation','none','separator']);
  const out = []; let ref = 0;
  const vis = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; };
  const nameOf = (el) => (el.getAttribute('aria-label') || el.value ||
    el.getAttribute('placeholder') || (el.innerText||'').trim() || '').slice(0,120);
  for (const el of document.querySelectorAll('*')) {
    const ar = el.getAttribute('role');
    const interactive = INTERACTIVE.has(el.tagName.toLowerCase()) ||
      (ar && !SKIP.has(ar)) || el.getAttribute('contenteditable')==='true';
    if (!interactive || !vis(el)) continue;
    ref += 1; el.setAttribute('data-mb-ref', String(ref));
    out.push({ ref, role: ar || el.tagName.toLowerCase(), name: nameOf(el) });
  }
  return out;
})()
"""

def format_snapshot(raw: list[dict[str, Any]], max_bytes: int = 32_000) -> str:
    lines = []
    for el in raw:
        name = (el.get("name") or "").strip()
        role = el.get("role") or "generic"
        if not name and role in ("generic", "div", "span"):
            continue
        lines.append(f'[{el["ref"]}] {role} {name}'.rstrip())
    if not lines:
        return "(no interactive elements)"
    out, used = [], 0
    for ln in lines:
        size = len((ln + "\n").encode())
        if used + size > max_bytes - 32:
            out.append("… (truncated)")
            break
        out.append(ln); used += size
    return "\n".join(out)
