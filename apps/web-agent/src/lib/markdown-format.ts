/** 文本 + 选区（扁平偏移）。所有变换返回新文本与变换后应选中的范围。 */
export interface EditState {
  text: string;
  start: number;
  end: number;
}

/** 行内标记包裹；若选区紧邻外侧已是该标记则切换去除。空选区插入成对标记，光标居中。 */
export function wrapInline(s: EditState, marker: string): EditState {
  const before = s.text.slice(0, s.start);
  const sel = s.text.slice(s.start, s.end);
  const after = s.text.slice(s.end);
  if (before.endsWith(marker) && after.startsWith(marker)) {
    const nb = before.slice(0, before.length - marker.length);
    const na = after.slice(marker.length);
    return {
      text: nb + sel + na,
      start: nb.length,
      end: nb.length + sel.length,
    };
  }
  const text = before + marker + sel + marker + after;
  return {
    text,
    start: s.start + marker.length,
    end: s.end + marker.length,
  };
}

/** 对选区覆盖的整行加前缀；若所有行都已有该前缀则去除（切换）。 */
export function applyLinePrefix(s: EditState, prefix: string): EditState {
  const lineStart = s.text.lastIndexOf("\n", s.start - 1) + 1;
  let lineEnd = s.text.indexOf("\n", s.end);
  if (lineEnd === -1) lineEnd = s.text.length;
  const block = s.text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const allPrefixed = lines.every((l) => l.startsWith(prefix));
  const newLines = allPrefixed
    ? lines.map((l) => l.slice(prefix.length))
    : lines.map((l) => prefix + l);
  const newBlock = newLines.join("\n");
  const text = s.text.slice(0, lineStart) + newBlock + s.text.slice(lineEnd);
  return { text, start: lineStart, end: lineStart + newBlock.length };
}

/** 用 ``` 围栏包裹选区。 */
export function applyCodeBlock(s: EditState): EditState {
  const before = s.text.slice(0, s.start);
  const sel = s.text.slice(s.start, s.end);
  const after = s.text.slice(s.end);
  const fenced = `\`\`\`\n${sel}\n\`\`\``;
  return {
    text: before + fenced + after,
    start: before.length + 4,
    end: before.length + 4 + sel.length,
  };
}

/** 把选区变成 [文字](url)；选中 url 占位便于继续输入。空选区用 "文字" 作占位文本。 */
export function applyLink(s: EditState, url: string): EditState {
  const before = s.text.slice(0, s.start);
  const sel = s.text.slice(s.start, s.end) || "文字";
  const after = s.text.slice(s.end);
  const inserted = `[${sel}](${url})`;
  const urlStart = before.length + 1 + sel.length + 2; // "[" + sel + "](" 之后
  return {
    text: before + inserted + after,
    start: urlStart,
    end: urlStart + url.length,
  };
}
