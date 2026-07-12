/**
 * loopback 回调结果页（成功/失败）——浏览器完成授权码回传后的落地页。
 * 自包含单文件 HTML（内联样式/脚本，无外部资源），品牌视觉与 web 端 auth 流程一致。
 */
export function renderAuthorizeResultPage(kind: "success" | "failure"): string {
  const ok = kind === "success";
  const icon = ok
    ? `<div class="ring ok"><span>✓</span></div>`
    : `<div class="ring bad"><span>✕</span></div>`;
  const title = ok ? "授权成功" : "授权失败或已过期";
  const sub = ok
    ? "MeshBot 桌面端已自动登录，本页可以关闭。"
    : "请回到 MeshBot 桌面端重试。";
  const closeScript = ok
    ? `<script>setTimeout(function(){window.close()},1500)</script>`
    : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MeshBot</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#f7f2ea;font-family:-apple-system,"PingFang SC",sans-serif;color:#2b2723}
  .wrap{text-align:center;padding:32px}
  .logo{display:inline-flex;align-items:center;gap:8px;margin-bottom:24px;font-weight:800}
  .logo i{display:inline-flex;width:34px;height:34px;background:#2b2723;border-radius:9px;
    color:#fff;align-items:center;justify-content:center;font-style:normal}
  .ring{width:56px;height:56px;margin:0 auto 14px;border-radius:50%;
    display:flex;align-items:center;justify-content:center;animation:pop .4s ease-out}
  .ring span{width:34px;height:34px;border-radius:50%;color:#fff;display:flex;
    align-items:center;justify-content:center;font-size:18px;font-weight:800}
  .ring.ok{background:rgba(22,163,74,.1)} .ring.ok span{background:#16a34a}
  .ring.bad{background:rgba(220,38,38,.08)} .ring.bad span{background:#dc2626}
  h1{font-size:18px;margin:0} p{font-size:13px;color:#8a8178;margin-top:8px}
  @keyframes pop{0%{transform:scale(.6);opacity:0}100%{transform:scale(1);opacity:1}}
</style></head><body><div class="wrap">
  <div class="logo"><i>M</i>MeshBot</div>
  ${icon}<h1>${title}</h1><p>${sub}</p>
</div>${closeScript}</body></html>`;
}
