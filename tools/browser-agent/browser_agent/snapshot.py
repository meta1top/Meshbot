"""页面快照：浏览器侧 JS 采集（打 data-mb-ref）+ Python 侧精简/截断。"""
from __future__ import annotations

from typing import Any

# 在页面里执行：给可交互元素打 ref，返回 [{ref, role, name}]。
# role 取 ARIA role 或标签名兜底；name 取可见文本 / aria-label / placeholder。
COLLECT_JS = r"""
() => {
  const INTERACTIVE = new Set(['a','button','input','textarea','select','summary']);
  // 纯装饰/排版 role：truthy 但不可交互，必须排除，否则每个快照都被噪声塞满。
  const SKIP_ROLES = new Set(['presentation','none','separator']);
  const out = [];
  let ref = 0;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  // name 优先取已填 value（让 LLM 看到输入框真实内容），再退到 placeholder/文本。
  const nameOf = (el) =>
    (el.getAttribute('aria-label') || el.value ||
     el.getAttribute('placeholder') || (el.innerText || '').trim() || '').slice(0, 120);
  for (const el of document.querySelectorAll('*')) {
    const ariaRole = el.getAttribute('role');
    const role = ariaRole || el.tagName.toLowerCase();
    const interactive = INTERACTIVE.has(el.tagName.toLowerCase()) ||
                        (ariaRole && !SKIP_ROLES.has(ariaRole)) ||
                        el.getAttribute('contenteditable') === 'true';
    if (!interactive || !visible(el)) continue;
    ref += 1;
    el.setAttribute('data-mb-ref', String(ref));
    out.push({ ref, role, name: nameOf(el) });
  }
  return out;
}
"""


def format_snapshot(raw: list[dict[str, Any]], max_bytes: int = 32_000) -> str:
    """把采集到的元素列表格式化成给 LLM 的精简文本，按字节预算截断。"""
    lines: list[str] = []
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
        size = len((ln + "\n").encode("utf-8"))
        if used + size > max_bytes - 32:
            out.append("… (truncated)")
            break
        out.append(ln)
        used += size
    return "\n".join(out)
