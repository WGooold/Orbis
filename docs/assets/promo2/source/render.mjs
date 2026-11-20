import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { launchBrowser, labelHostCapture } from './browser.mjs';
import { makeMessageUI, messageCSS } from './message-ui.mjs';
import { renderMessageScreens } from './render-message-screens.mjs';

// Inside source/: npm ci && npx playwright install chromium && npm run render
// Assets are local; macOS with PingFang SC matches the reference typography.
// PROMO_WORK selects where to save intermediate HTML, screens and layout checks.
const source = path.dirname(fileURLToPath(import.meta.url));
const out = path.dirname(source);
const assets = path.join(source, 'assets');
const work = process.env.PROMO_WORK || path.resolve(out, '../../../.artifacts/promo2-render');
await mkdir(work, { recursive: true });
await mkdir(out, { recursive: true });

const dataUriCache = new Map();
function toDataUri(absPath) {
  if (dataUriCache.has(absPath)) return dataUriCache.get(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const mime =
    ext === '.svg' ? 'image/svg+xml'
    : ext === '.png' ? 'image/png'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.woff2' ? 'font/woff2'
    : 'application/octet-stream';
  const uri = `data:${mime};base64,${readFileSync(absPath).toString('base64')}`;
  dataUriCache.set(absPath, uri);
  return uri;
}

const assetUri = name => toDataUri(path.join(assets, name));
const katexPath = path.join(assets, 'math/katex.min.js');
const katexCss = readFileSync(path.join(assets, 'math/katex.min.css'), 'utf8').replace(/url\((fonts\/[^)]+)\)/g, (_, rel) => {
  const font = path.join(assets, 'math', rel);
  return existsSync(font) ? `url(${toDataUri(font)})` : 'url(about:blank)';
});
const orbisMarkUri = assetUri('orbis-symbol-2048.png');
const messageUI = makeMessageUI({
  agentUri: id => assetUri(({ codex:'AgentCodex', pi:'AgentPi', claude:'AgentClaude', deepseek:'AgentDeepSeek' }[id]) + '.svg'),
  orbisUri:orbisMarkUri, pairingMarkUri:assetUri('OrbisMark.png'),
});
const browser = await launchBrowser();
try {
const screenChecks = await renderMessageScreens({ browser,screens:messageUI.screens,work,katexCss,katexPath });
const screenUri = name => toDataUri(path.join(work,'screens',`${name}.png`));
const hostPage = await browser.newPage();
const desktopAgents = await labelHostCapture(hostPage,assetUri('host-agent-list.png'));
const desktopOverview = await labelHostCapture(hostPage,assetUri('host-overview.png'));
await hostPage.close();

const pos = (x, y, w, other = '') => `left:${x}px;top:${y}px;${w ? `width:${w}px;` : ''}${other}`;
const icon = (name, size = 24) => `<img class="ui-icon" src="${assetUri(`${name}.svg`)}" style="width:${size}px;height:${size}px" alt="">`;
const header = '<div class="brand"><span class="orbis-mark"></span><b>Orbis</b></div>';
const orbit = '<div class="orbit" aria-hidden="true"><i></i><i></i></div>';
const heading = ([first, second]) => `<h1 class="heading">${first}<br><em>${second}</em></h1>`;

function messagePhone(name, x, y, width, angle = 0) {
  return `<div class="device" style="${pos(x, y, width, `transform:rotate(${angle}deg)`)}">
    <i class="side side-a"></i><i class="side side-b"></i>
    <div class="device-screen"><img src="${screenUri(name)}" class="screen-img" alt="Orbis 示例界面"></div>
  </div>`;
}

const page = (n, slug, headline, artwork) => ({
  n,
  slug,
  headline,
  body: header + orbit + heading(headline) + artwork,
});

const posters = [
  page(1, 'smoothest-remote-cover', ['电脑上跑任务，', '手机接着聊'],
    messagePhone('lock-cover', 150, 343, 294, -3) +
    messagePhone('chat-cover', 421, 394, 326, 2.2)),

  page(2, 'live-activity', ['灵动岛上，', '随时看任务进度'],
    messagePhone('lock-attention', 270, 320, 360)),

  page(3, 'math-rendering', ['公式和表格，', '直接在对话里看'],
    messagePhone('chat-math', 264, 315, 372)),

  page(4, 'desktop-and-phone-sync', ['同一段 DSH 对话，', '换到手机继续'],
    `<figure class="desktop-shot sync-shot"><img src="${desktopAgents}" alt="Orbis Host 的 Agent 列表，含 DSH 桌面版"></figure>` +
    messagePhone('chat-deepseek', 520, 346, 308, 1.6)),

  page(5, 'easier-pairing', ['从相册选张图，', '就能配对'],
    messagePhone('pair-entry', 123, 340, 305, -2.4) +
    messagePhone('pair-scan', 457, 395, 316, 2.2)),
];

const inlineSvg = (d, size = 12, vb = '0 0 24 24', color = 'currentColor') =>
  `<svg width="${size}" height="${size}" viewBox="${vb}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex:none" aria-hidden="true">${d}</svg>`;
const archiveSvg = (s = 12) => inlineSvg('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>', s);
const shieldCheckSvg = (s = 10, c = '#176548') => inlineSvg('<path d="M12 3l7 3v5c0 4.5-3 8.2-7 9.8C8 19.2 5 15.5 5 11V6l7-3z"/><path d="M9.5 12l1.8 1.8 3.4-3.6"/>', s, '0 0 24 24', c);
const railChatFillSvg = (s = 11) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v9a2.5 2.5 0 0 1-2.5 2.5H9.4l-3.9 3.2A.7.7 0 0 1 4.3 19.6V17A2.5 2.5 0 0 1 4 14.5z"/></svg>`;
const railTuneSvg = (s = 11) => inlineSvg('<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="1.6" fill="currentColor"/><circle cx="15" cy="12" r="1.6" fill="currentColor"/><circle cx="10" cy="17" r="1.6" fill="currentColor"/>', s);
const railGearSvg = (s = 11) => inlineSvg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1z"/>', s);

// Shared mini Crescent Wi-Fi + 4-dot signal gauge from iPhone Duo vertical rail
const duoSignalSvg = (w = 20, h = 16) => `<svg viewBox="0 0 36 30" width="${w}" height="${h}" aria-hidden="true">
  <path d="M5 18 A13 13 0 0 1 31 18" fill="none" stroke="#1e242e" stroke-width="2.6" stroke-linecap="round"/>
  <path d="M10 17 A8 8 0 0 1 26 17" fill="none" stroke="#1e242e" stroke-width="2.3" stroke-linecap="round"/>
  <path d="M14.5 19 A3.5 3.5 0 0 1 21.5 19" fill="none" stroke="#1e242e" stroke-width="2.2" stroke-linecap="round"/>
  <circle cx="18" cy="21" r="1.8" fill="#1e242e"/>
  <circle cx="11" cy="25.5" r="1.4" fill="#94a0b3"/>
  <circle cx="15.5" cy="26.5" r="1.4" fill="#1e242e"/>
  <circle cx="20.5" cy="26.5" r="1.4" fill="#1e242e"/>
  <circle cx="25" cy="25.5" r="1.4" fill="#1e242e"/>
</svg>`;

const duoRailHtml = (compact = false) => `
  <div class="duo-rail${compact ? ' is-compact' : ''}">
    <div class="duo-rail-status"><b>9:41</b>${duoSignalSvg(compact ? 17 : 20, compact ? 13 : 16)}</div>
    ${compact ? '' : `<span class="duo-rail-btn">≡</span>`}
    <div class="duo-rail-group"><span>↓</span><span>+</span></div>
    <div class="duo-rail-tabs">
      <span class="is-on">${railChatFillSvg(compact ? 10 : 11)}</span>
      <span>${railTuneSvg(compact ? 10 : 11)}</span>
      <span>${railGearSvg(compact ? 10 : 11)}</span>
    </div>
  </div>
`;

// 6. IPHONE DUO FOLDABLE SUPPORT (1800 x 2400)
posters.push(page(6, 'iphone-duo', ['折叠、半展、展开，', '界面随姿态调整'], `
  <div class="duo-landscape-wrap" style="${pos(71, 344, 446)}">
    <div class="duo-chassis" style="left:0;top:0;width:640px;transform:scale(0.696875);transform-origin:top left">
      <i class="hinge-cap top"></i>
      <i class="hinge-cap bottom"></i>
      <div class="duo-screen">
        <div class="duo-hinge-line" aria-hidden="true"></div>
        <div class="duo-pane duo-left">
          <div class="duo-left-tools">
            <div class="duo-search-bar">${icon('material-search', 14)}<span>搜索目录或会话</span></div>
            <span class="duo-tool-ic">${archiveSvg(13)}</span>
            <span class="duo-tool-ic">≡</span>
          </div>
          <div class="duo-dir-head"><b>工作目录</b><small>2 个目录</small></div>
          <div class="duo-folder-card">${icon('material-folder', 15)}<b>orbis</b><span>6 ›</span></div>
          <div class="duo-folder-card">${icon('material-folder', 15)}<b>website</b><span>1 ›</span></div>
          <div class="duo-host-footer">
            ${icon('material-desktop', 16)}
            <div><b>工作电脑</b><small><i></i>已连接</small></div>
            <span>›</span>
          </div>
        </div>

        <div class="duo-pane duo-right">
          <div class="duo-right-main">
            <div class="duo-brand-center"><b>Orbis</b><small>Easy Agents Everywhere</small></div>
            <div class="duo-conn-bar">
              <span>${icon('material-desktop', 13)} 工作电脑</span>
              <span class="duo-conn-pill"><i></i>中继 ${shieldCheckSvg(10)}</span>
            </div>
            <div class="duo-home-list">
              <div class="duo-home-card">
                <div class="duo-hc-ico">${messageUI.nativeAgent('codex', 18)}</div>
                <div class="duo-hc-meta"><b>对齐移动端的使用体验</b><em>/Projects/orbis</em><small class="c-codex"><span>Codex</span> ○ 空闲</small></div>
              </div>
              <div class="duo-home-card">
                <div class="duo-hc-ico">${messageUI.nativeAgent('pi', 18)}</div>
                <div class="duo-hc-meta"><b>梳理项目中的页面结构</b><em>/Projects/website</em><small class="c-pi"><span>Pi</span> ○ 空闲</small></div>
              </div>
              <div class="duo-home-card">
                <div class="duo-hc-ico">${messageUI.nativeAgent('deepseek', 18)}</div>
                <div class="duo-hc-meta"><b>检查服务端连接状态</b><em>/Projects/orbis</em><small class="c-dsh"><span>DSH</span> ○ 空闲</small></div>
              </div>
            </div>
          </div>
          ${duoRailHtml(true)}
        </div>
      </div>
    </div>
  </div>

  <div class="duo3d-scene" style="${pos(502, 502, 342)}">
    <div class="duo3d-shadow" aria-hidden="true"></div>
    <div class="duo3d-rig">
      <div class="duo3d-leaf is-top">
        <i class="d3d-slice s1" aria-hidden="true"></i>
        <i class="d3d-slice s2" aria-hidden="true"></i>
        <i class="d3d-slice s3" aria-hidden="true"></i>
        <i class="d3d-slice s4" aria-hidden="true"></i>
        <i class="d3d-slice s5" aria-hidden="true"></i>
        <div class="d3d-face d3d-top-face">
          <div class="d3d-crease-ao top" aria-hidden="true"></div>
          <img class="duo-ui-insert" src="${screenUri('duo-reading')}" alt="上屏聊天消息">
        </div>
      </div>

      <div class="duo3d-hinge" aria-hidden="true">
        <i class="hinge-barrel"></i>
        <i class="hinge-tip left"></i>
        <i class="hinge-tip right"></i>
      </div>

      <div class="duo3d-leaf is-bottom">
        <i class="d3d-slice s1" aria-hidden="true"></i>
        <i class="d3d-slice s2" aria-hidden="true"></i>
        <i class="d3d-slice s3" aria-hidden="true"></i>
        <i class="d3d-slice s4" aria-hidden="true"></i>
        <i class="d3d-slice s5" aria-hidden="true"></i>
        <div class="d3d-face d3d-bottom-face">
          <div class="d3d-crease-ao bottom" aria-hidden="true"></div>
          <img class="duo-ui-insert" src="${screenUri('duo-controls')}" alt="下屏聊天操作">
        </div>
      </div>
    </div>
  </div>

  <div class="duo-folded-device" style="${pos(186, 724, 214, 'transform:rotate(-2deg)')}">
    <div class="duo-folded-screen">
      <div class="duo-folded-main">
        <div class="duo-folded-brand"><b>Orbis</b><small>Easy Agents Everywhere</small></div>
        <div class="duo-folded-status">
          <span class="dfs-host">${icon('material-desktop', 10)}工作电脑</span>
          <span class="dfs-pill"><i></i>中继 ${shieldCheckSvg(8)}</span>
        </div>
        <div class="duo-folded-card">${messageUI.nativeAgent('codex', 15)}<div><b>对齐移动端的使用体验</b><em>/Projects/orbis</em><small class="c-codex">Codex · ○ 空闲</small></div></div>
        <div class="duo-folded-card">${messageUI.nativeAgent('pi', 15)}<div><b>梳理项目中的页面结构</b><em>/Projects/website</em><small class="c-pi">Pi · ○ 空闲</small></div></div>
        <div class="duo-folded-card">${messageUI.nativeAgent('deepseek', 15)}<div><b>检查服务端连接状态</b><em>/Projects/orbis</em><small class="c-dsh">DSH · ○ 空闲</small></div></div>
      </div>
      ${duoRailHtml(false)}
    </div>
  </div>

`));

posters.push(page(7, 'host-guided-redesign', ['打开桌面概览，', '连接状态一目了然'],
  `<figure class="desktop-shot host-shot"><img src="${desktopOverview}" alt="Orbis Host 的桌面概览"></figure>`));

posters.push(page(8, 'refined-details', ['翻看旧消息，', '阅读位置不跳动'],
  messagePhone('chat-details', 266, 318, 368)));

const css = String.raw`
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;background:#eef3fa;color:#1e2d42;-webkit-font-smoothing:antialiased}
.poster{position:relative;width:900px;height:1200px;overflow:hidden;isolation:isolate;background:radial-gradient(ellipse at 51% 61%,#dce7f5 0%,transparent 65%),linear-gradient(155deg,#f8faff,#e8eff8)}
.brand{position:absolute;left:64px;top:43px;display:flex;align-items:center;gap:11px;height:43px;z-index:2}
.brand b{font-size:30px;font-weight:650;letter-spacing:-1px}
.orbis-mark{display:inline-block;width:36px;height:36px;background:currentColor;mask:url('${orbisMarkUri}') center/contain no-repeat;-webkit-mask:url('${orbisMarkUri}') center/contain no-repeat}
.heading{position:absolute;left:64px;top:133px;right:64px;margin:0;font-size:67px;line-height:1.17;font-weight:650;letter-spacing:-2.3px;z-index:2}
.heading em{font-style:normal;color:#2f5287}
.orbit{position:absolute;inset:346px 60px auto;height:780px;pointer-events:none;z-index:0}
.orbit i{position:absolute;inset:0;border:1px solid #829dbe36;border-radius:50%}
.orbit i:nth-child(2){inset:69px}

.device{position:absolute;padding:8px;border-radius:47px;background:linear-gradient(130deg,#f3f6fb,#bfc9d7 40%,#f8faff 90%);border:1px solid #ffffffd0;box-shadow:13px 24px 42px #52688835,-7px -8px 18px #ffffffa6,1px 3px 3px #73829d5c;z-index:3;transform-origin:center center}
.device:after{content:"";position:absolute;inset:2px;border:1px solid #7485a13b;border-radius:45px;pointer-events:none}
.device-screen{overflow:hidden;border-radius:39px;background:#e6ebf4;position:relative}
.screen-img{display:block;width:100%;height:auto}
.side{position:absolute;width:3px;background:#c1cad7;border-radius:3px;left:-3px}
.side-a{height:38px;top:96px}
.side-b{height:59px;top:153px}
.ui-icon{display:inline-block;object-fit:contain;flex:none}

.desktop-shot{position:absolute;margin:0;padding:8px;border:1px solid #fff;border-radius:19px;background:#f6f9fe;box-shadow:0 20px 42px #52688837;z-index:1}
.desktop-shot img{display:block;width:100%;height:auto;border-radius:11px}
.sync-shot{left:64px;top:492px;width:521px}
.host-shot{left:64px;top:446px;width:772px}

/* Poster 6: iPhone Duo Foldable */
.duo-landscape-wrap{position:absolute;height:336px;z-index:4}
.duo-chassis{position:absolute;height:452px;padding:9px;border-radius:36px;background:linear-gradient(135deg,#f4f7fc,#c4cedc 45%,#f7fafe 90%);border:1px solid #ffffffda;box-shadow:18px 28px 46px #72829e4c,-8px -8px 22px #ffffffb8;z-index:4}
.duo-chassis:after{content:"";position:absolute;inset:2px;border:1px solid #7485a133;border-radius:34px;pointer-events:none}
.hinge-cap{position:absolute;left:50%;transform:translateX(-50%);width:36px;height:5px;border-radius:3px;background:#a8b5c8;z-index:8}
.hinge-cap.top{top:2px}.hinge-cap.bottom{bottom:2px}
.duo-screen{position:relative;width:100%;height:100%;border-radius:28px;background:#e6ebf4;overflow:hidden;display:grid;grid-template-columns:43fr 57fr;box-shadow:inset 1px 1px 4px #6d7e9944}
.duo-hinge-line{position:absolute;left:43%;top:0;bottom:0;width:14px;transform:translateX(-50%);background:linear-gradient(90deg,transparent,#8fa1b924 38%,#62759142 50%,#ffffff8c 54%,transparent);z-index:12;pointer-events:none}
.duo-pane{padding:16px 18px 14px;display:flex;flex-direction:column;position:relative;min-width:0}
.duo-left{background:#e3e9f3;padding-right:20px}
.duo-right{background:#e7ecf5;padding:12px 10px 12px 20px;display:grid;grid-template-columns:1fr 31px;gap:8px}
.duo-right-main{display:flex;flex-direction:column;min-width:0}
.duo-left-tools{display:flex;align-items:center;gap:7px;margin-bottom:16px}
.duo-search-bar{flex:1;display:flex;align-items:center;gap:6px;padding:8px 11px;border-radius:14px;background:#dfe6f1;box-shadow:inset 2px 2px 5px #9aaac055,inset -2px -2px 5px #ffffffbf;font-size:10.5px;color:#73859e;white-space:nowrap}
.duo-tool-ic{width:29px;height:29px;border-radius:50%;display:grid;place-items:center;background:#e8eef6;box-shadow:3px 3px 7px #a6b2c65a,-3px -3px 7px #ffffffd8;font-size:13px;color:#2b3648;flex:none}
.duo-dir-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.duo-dir-head b{font-size:12px;color:#38475d;font-weight:600}
.duo-dir-head small{font-size:10px;color:#6f829c}
.duo-folder-card{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:14px;background:#e8eef6;box-shadow:3px 3px 8px #a6b2c64d,-3px -3px 8px #ffffffcc;font-size:12px;font-weight:600;color:#232a36;margin-bottom:10px}
.duo-folder-card span{margin-left:auto;font-size:11px;color:#74869e;font-weight:500}
.duo-host-footer{margin-top:auto;padding-top:11px;border-top:1px solid #cbd6e485;display:flex;align-items:center;gap:9px;color:#2e3a4e}
.duo-host-footer b{display:block;font-size:11.5px;color:#232a36;line-height:1.1}
.duo-host-footer small{display:flex;align-items:center;gap:4px;font-size:9px;color:#1a6a4d;margin-top:2px}
.duo-host-footer small i{width:5px;height:5px;border-radius:50%;background:#1a6a4d;display:inline-block}
.duo-host-footer>span{margin-left:auto;color:#6f829c;font-size:14px}
.duo-brand-center{text-align:center;margin:8px 0 11px}
.duo-brand-center b{display:block;font-size:13.5px;color:#2e3a4e;line-height:1.1}
.duo-brand-center small{display:block;font-size:8px;color:#6f829c;margin-top:1px}
.duo-conn-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:11px;font-size:10.5px;color:#2e3a4e}
.duo-conn-bar>span:first-child{display:flex;align-items:center;gap:5px;font-weight:600}
.duo-conn-pill{display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;background:#eaf0f8;box-shadow:2px 2px 6px #a6b2c652,-2px -2px 6px #ffffffcc;font-size:9.5px;color:#176548;font-weight:600}
.duo-conn-pill i{width:5px;height:5px;border-radius:50%;background:#1b7a57;display:inline-block}
.duo-home-list{display:grid;gap:10px}
.duo-home-card{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:16px;background:#edf2f9;box-shadow:5px 5px 12px #a6b2c652,-5px -5px 12px #ffffffd8}
.duo-hc-ico{width:26px;height:28px;display:grid;place-items:center;flex:none}
.duo-hc-meta{min-width:0}
.duo-hc-meta b{display:block;font-size:11.5px;color:#232a36;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.duo-hc-meta em{display:block;font-style:normal;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:8.5px;color:#62748b;margin-bottom:2px}
.duo-hc-meta small{display:flex;align-items:center;gap:5px;font-size:9px;color:#5a6d85;font-weight:500}
.c-codex span{color:#157958;font-weight:600}
.c-pi span{color:#7a3860;font-weight:600}
.c-dsh span{color:#2f5287;font-weight:600}

/* Shared Vertical Right System Rail (Folded & Unfolded Landscape) */
.duo-rail{display:flex;flex-direction:column;align-items:center;gap:6px;padding:4px 2px;border-radius:16px;background:#ffffff30;border:1px solid #ffffff52}
.duo-rail.is-compact{background:transparent;border:none;padding:2px 0;gap:7px}
.duo-rail-status{text-align:center;line-height:1}
.duo-rail-status b{display:block;font-size:7px;font-weight:700;color:#1e242e;margin-bottom:2px}
.duo-rail.is-compact .duo-rail-status b{font-size:8px}
.duo-rail-btn{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:#ffffffb8;border:1px solid #ffffffeb;box-shadow:0 2px 6px #788ca830;font-size:11px;color:#232a36}
.duo-rail-group{width:24px;border-radius:14px;background:#ffffffb8;border:1px solid #ffffffeb;box-shadow:0 2px 6px #788ca830;display:grid;text-align:center;padding:3px 0;gap:5px;font-size:10.5px;font-weight:600;color:#232a36;line-height:1.2}
.duo-rail-tabs{margin-top:auto;width:24px;border-radius:14px;background:#ffffffb8;border:1px solid #ffffffeb;box-shadow:0 3px 8px #7285a22e;padding:3px;display:grid;gap:4px}
.duo-rail-tabs span{height:20px;border-radius:10px;display:grid;place-items:center;color:#354052;opacity:.85}
.duo-rail-tabs span.is-on{background:#dce5f3;color:#2f5287;opacity:1;box-shadow:inset 0 0 0 1px #ffffffc0}

/* Half-Open Portrait: True 3D Clamshell Hardware Reading Posture */
.duo3d-scene{position:absolute;height:420px;perspective:1040px;perspective-origin:34% 32%;z-index:8}
.duo3d-shadow{position:absolute;left:-4px;top:256px;width:316px;height:142px;background:radial-gradient(ellipse at 48% 54%,#4c618356,#6f84a626 52%,transparent 75%);filter:blur(12px);transform:rotate(-2deg);pointer-events:none}
.duo3d-rig{position:relative;width:330px;height:450px;margin:0 auto;transform-style:preserve-3d;transform:rotateY(-15deg) rotateX(0deg)}
.duo3d-leaf{position:absolute;left:0;width:330px;transform-style:preserve-3d}
.duo3d-leaf.is-top{top:0;height:220px;transform-origin:50% 100%;transform:rotateX(5deg)}
.duo3d-leaf.is-bottom{top:222px;height:224px;transform-origin:50% 0%;transform:rotateX(44deg)}
.d3d-slice{position:absolute;inset:0;pointer-events:none;border:1px solid #7d8da566}
.duo3d-leaf.is-top .d3d-slice{border-radius:26px 26px 9px 9px}
.duo3d-leaf.is-bottom .d3d-slice{border-radius:9px 9px 28px 28px}
.d3d-slice.s1{transform:translateZ(-2.5px);background:#e3e9f3}
.d3d-slice.s2{transform:translateZ(-5.5px);background:#c7d2e1}
.d3d-slice.s3{transform:translateZ(-8.5px);background:#9aa9bf}
.d3d-slice.s4{transform:translateZ(-11px);background:#7f90a8}
.d3d-slice.s5{transform:translateZ(-13px);background:#697991;box-shadow:0 10px 22px #2b3c5842}
.d3d-face{position:absolute;inset:0;transform:translateZ(.5px);padding:7px;border:1px solid #ffffffea;background:linear-gradient(155deg,#f6f9fe,#dde4ef);display:flex;flex-direction:column;overflow:hidden}
.duo3d-leaf.is-top .d3d-face{border-radius:26px 26px 9px 9px;box-shadow:inset 0 1px 0 #ffffff}
.duo3d-leaf.is-bottom .d3d-face{border-radius:9px 9px 28px 28px;box-shadow:inset 0 1px 0 #ffffff}
.d3d-face:before{content:"";position:absolute;inset:6px;background:#e6ebf4;box-shadow:inset 1px 1px 4px #6d7e9940;z-index:0}
.duo3d-leaf.is-top .d3d-face:before{border-radius:20px 20px 6px 6px}
.duo3d-leaf.is-bottom .d3d-face:before{border-radius:6px 6px 22px 22px}
.d3d-top-face,.d3d-bottom-face{padding:6px}
.d3d-face>.duo-ui-insert{position:absolute;inset:6px;width:calc(100% - 12px);height:calc(100% - 12px);object-fit:fill;display:block;border-radius:inherit}
.d3d-top-face>*,.d3d-bottom-face>*{position:relative;z-index:1}
.d3d-crease-ao{position:absolute;left:6px;right:6px;height:20px;pointer-events:none;z-index:2!important}
.d3d-crease-ao.top{bottom:6px;background:linear-gradient(180deg,transparent,#6b7c9624);border-radius:0 0 6px 6px}
.d3d-crease-ao.bottom{top:6px;background:linear-gradient(180deg,#64759138,transparent);border-radius:6px 6px 0 0}
.duo3d-hinge{position:absolute;left:-4px;right:-4px;top:215px;height:12px;transform-style:preserve-3d;transform:translateZ(-3.5px);pointer-events:none}
.hinge-barrel{position:absolute;inset:0;border-radius:6px;background:linear-gradient(180deg,#eef3fc,#b5c2d5 42%,#798aa2 76%,#cdd7e6);border:1px solid #ffffffa8;box-shadow:0 3px 8px #26365038}
.hinge-tip{position:absolute;top:1px;bottom:1px;width:9px;border-radius:4px;background:linear-gradient(180deg,#dde4f0,#8e9db4 65%,#b9c6d8);border:1px solid #ffffff90}
.hinge-tip.left{left:0}.hinge-tip.right{right:0}

.duo-folded-device{position:absolute;padding:6px;border-radius:28px;background:linear-gradient(130deg,#f3f6fb,#bfc9d7 40%,#f8faff 90%);border:1px solid #ffffffd0;box-shadow:14px 20px 36px #6f809c55,-6px -6px 16px #ffffffb5;z-index:6}
.duo-folded-screen{border-radius:22px;background:#e6ebf4;padding:8px 6px 8px 8px;display:grid;grid-template-columns:1fr 30px;gap:6px;aspect-ratio:1374/2000}
.duo-folded-main{display:flex;flex-direction:column;gap:6px;min-width:0}
.duo-folded-brand{text-align:center;margin:2px 0 3px}
.duo-folded-brand b{display:block;font-size:10px;color:#2e3a4e;line-height:1.1;font-weight:650}
.duo-folded-brand small{display:block;font-size:6px;color:#667890;letter-spacing:.2px}
.duo-folded-status{display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:2px}
.dfs-host{display:flex;align-items:center;gap:3px;font-size:7.5px;font-weight:600;color:#2e3a4e}
.dfs-pill{display:inline-flex;align-items:center;gap:3px;padding:2.5px 6px;border-radius:999px;background:#eaf0f8;box-shadow:2px 2px 5px #a6b2c64d,-2px -2px 5px #ffffffd0;font-size:7px;color:#176548;font-weight:600}
.dfs-pill i{width:4px;height:4px;border-radius:50%;background:#1b7a57;display:inline-block}
.duo-folded-card{display:flex;align-items:center;gap:5.5px;padding:6.5px 6.5px;border-radius:11px;background:#edf2f9;box-shadow:3px 3px 7px #a6b2c652,-3px -3px 7px #ffffffd4;min-width:0}
.duo-folded-card>div{min-width:0}
.duo-folded-card b{display:block;font-size:7.3px;color:#232a36;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.duo-folded-card em{display:block;font-style:normal;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:6px;color:#62748b;margin:1.5px 0 1px}
.duo-folded-card small{display:block;font-size:6.2px;color:#62748b}
.duo-folded-card small.c-codex{color:#157958;font-weight:600}
.duo-folded-card small.c-pi{color:#7a3860;font-weight:600}
.duo-folded-card small.c-dsh{color:#2f5287;font-weight:600}

`;

const makeHtml = (p) => `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>Orbis — ${p.slug}</title>
<style>${messageCSS}\n${css}</style>
<body>
  <article class="poster">${p.body}</article>
</body>
</html>`;

const context = await browser.newContext({
  viewport: { width: 900, height: 1200 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
});

const records = [];
const failures = [];
try {
  const pageObj = context.pages()[0] || await context.newPage();
  pageObj.on('pageerror', (e) => failures.push(e.message));

  for (const p of posters) {
    const basename = `${String(p.n).padStart(2, '0')}-${p.slug}`;
    const vp = { width: 900, height: 1200 };
    const htmlStr = makeHtml(p);
    await writeFile(path.join(work, `${basename}.html`), htmlStr);

    await pageObj.setViewportSize(vp);
    await pageObj.setContent(htmlStr, { waitUntil: 'load' });
    await pageObj.evaluate(() => document.fonts.ready);
    await pageObj.waitForFunction(() => [...document.images].every((i) => i.complete));

    const check = await pageObj.evaluate(() => {
      const poster = document.querySelector('.poster');
      const headings = poster.querySelectorAll('h1');
      const heading = headings[0];
      const bounds = poster.getBoundingClientRect();
      // Product UI can carry its own text; the surrounding poster gets only the brand and headline.
      const artwork = [...poster.children].filter(el => !el.matches('.brand, .heading, .orbit'));
      return {
        headline: headings.length === 1 ? heading.innerText.trim().split('\n') : [],
        extraCopy: [...poster.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
          || artwork.some(el => !el.matches('.device, .desktop-shot, .duo-landscape-wrap, .duo3d-scene, .duo-folded-device')),
        brokenImages: [...document.images].filter(i => !i.naturalWidth).map(i => i.alt || 'img'),
        clippedArtwork: artwork.filter(el => {
          const r = el.getBoundingClientRect();
          return r.left < bounds.left || r.right > bounds.right || r.top < heading.getBoundingClientRect().bottom || r.bottom > bounds.bottom;
        }).map(el => el.className),
        titleOverflow: heading && heading.scrollWidth > heading.clientWidth,
      };
    });
    if (JSON.stringify(check.headline) !== JSON.stringify(p.headline) || check.extraCopy || check.brokenImages.length || check.clippedArtwork.length || check.titleOverflow) {
      throw new Error(`${basename} failed layout checks: ${JSON.stringify(check)}`);
    }

    const outPath = path.join(out, `${basename}.png`);
    await pageObj.locator('.poster').screenshot({ path: outPath });
    const bytes = await readFile(outPath);
    const dimensions = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    if (dimensions[0] !== 1800 || dimensions[1] !== 2400) throw new Error(`${basename}: unexpected PNG dimensions ${dimensions}`);
    records.push({
      name: `${basename}.png`,
      dimensions,
      headline: p.headline.join(''),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    console.log('Rendered', basename, `${vp.width * 2}x${vp.height * 2}`);
  }

  // Contact sheet (8 uniform 1800x2400 portraits in 4x2 grid)
  const sheetHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#cfd8e5;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;padding:20px;width:1200px}
    .sheet-head{display:flex;align-items:baseline;justify-content:space-between;padding:2px 2px 13px;margin-bottom:14px;border-bottom:1px solid #96a8c255;color:#304565}
    .sheet-head h1{margin:0;font-size:28px;letter-spacing:-1px;color:#304565}
    .sheet-head span{font-size:10.5px;font-weight:600;color:#4f6482;letter-spacing:.8px}
    .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
    .item img{width:100%;display:block;border-radius:8px;box-shadow:0 5px 14px #25365028}
  </style><body>
    <div class="sheet-head">
      <h1>Orbis</h1>
      <span>${records.length} 张 · 1800 × 2400</span>
    </div>
    <div class="grid">
      ${records.map((r) => `<div class="item"><img src="${toDataUri(path.join(out, r.name))}" alt="${r.headline}"></div>`).join('')}
    </div>
  </body></html>`;
  await writeFile(path.join(work, '00-contact-sheet.html'), sheetHtml);
  const sheetPage = await context.newPage();
  await sheetPage.setViewportSize({ width: 1200, height: 1000 });
  await sheetPage.setContent(sheetHtml, { waitUntil: 'load' });
  await sheetPage.evaluate(() => document.fonts.ready);
  await sheetPage.waitForFunction(() => [...document.images].every((i) => i.complete));
  await sheetPage.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sheetPage.locator('body').screenshot({ path: path.join(out, '00-contact-sheet.jpg'), type: 'jpeg', quality: 94 });
  await sheetPage.close();

  if (failures.length) throw new Error(`Page errors: ${JSON.stringify(failures)}`);
} finally {
  await context.close();
}

const evidence = {
  theme: '电脑上跑任务，手机接着聊',
  images: records,
  contactSheet: '00-contact-sheet.jpg',
  messageScreens: screenChecks.map(({name, dimensions, source, formulas}) => ({name, dimensions, source, formulas})),
  notes: 'Reconstructed promotional examples aligned to the iOS chat, markdown, fold reading, and live activity source. Desktop captures use the original layouts and editorial DSH labels. Per-screen overflow and rendering checks are in screens/checks.json.',
};
await writeFile(path.join(work, 'delivery-evidence.json'), JSON.stringify(evidence, null, 2));
console.log('Rendered', records.length, 'posters to', out);
} finally { await browser.close(); }
