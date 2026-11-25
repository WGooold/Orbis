const base = new URL("../", location.href);
const app = document.getElementById("app");
const dialog = document.getElementById("confirm-dialog");
const views = { overview: ["概览", "Relay 的运行状态，一目了然。", "◈"], hosts: ["Host", "管理已注册与正在连接的电脑。", "⊞"], devices: ["设备", "查看设备的 Relay 凭据与连接状态。", "▯"], bandwidth: ["带宽", "仅显示已同意分享用量的设备流量。", "⇄"], usage: ["增长遥测", "匿名服务汇总与已同意设备的使用明细。", "↗"], service: ["服务", "注册服务、版本与部署配置。", "⚙"], audit: ["操作记录", "最近 200 次管理操作，随服务数据持久保存。", "≡"] };
let bandwidthData, bandwidthPeriod = "today", bandwidthDevice = "";
let usageData, usageHistory = [], usageGranularity = "day", usageDevice = "";
let csrf = "", data, view = "overview", query = "", filter = "all", refreshing = false, mutation = false, timer, toastTimer, lastRefresh;
const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const errors = { unauthorized: "登录已失效，请重新输入管理员令牌。", invalid_origin: "请求来源不匹配，请通过本站地址访问后台。", invalid_csrf: "页面会话已更新，请刷新页面后重试。", invalid_granularity: "统计粒度无效，请重新选择。", telemetry_worker_unavailable: "遥测存储暂不可用。", admin_unavailable: "服务器尚未配置管理员令牌。", too_many_attempts: "尝试次数过多，请在 15 分钟后重试。", admin_busy: "管理会话数已达上限，请稍后重试。", device_not_found: "该设备已被撤销，请刷新列表。", host_not_found: "未找到该 Host，请刷新列表。", host_disabled: "请先重新启用该 Host，再重置激活。", internal_error: "服务端未能保存操作，请稍后重试。" };
const timestamp = value => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const uptime = seconds => seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟` : seconds < 86400 ? `${Math.floor(seconds / 3600)} 小时` : `${Math.floor(seconds / 86400)} 天`;
const badge = (online, disabled = false) => `<span class="status-pill ${disabled ? "warn" : online ? "" : "off"}">${disabled ? "已停用" : online ? "● 在线" : "○ 离线"}</span>`;
const brand = `<a class="brand" href="../"><img src="../assets/orbis.png" width="40" height="40" alt=""><span>Orbis</span></a>`;

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(new URL(`v1/admin/${path}`, base), { credentials: "same-origin", cache: "no-store", ...options, headers: { "content-type": "application/json", ...(csrf ? { "x-orbis-csrf": csrf } : {}) }, signal: controller.signal });
    const body = response.status === 204 ? {} : await response.json();
    if (!response.ok) { const error = new Error(errors[body.error] ?? "操作未完成，请稍后重试。"); error.code = body.error; throw error; }
    return body;
  } catch (error) {
    if (!error.code) error.message = "无法连接 Relay，请检查网络后重试。";
    throw error;
  } finally { clearTimeout(timeout); }
}
function toast(message) {
  const node = document.getElementById("toast");
  clearTimeout(toastTimer); node.textContent = message; node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 4500);
}
function login(message = "") {
  clearInterval(timer); csrf = ""; data = undefined; dialog.close();
  app.innerHTML = `<main class="login-layout" id="main"><section class="login-intro">${brand}<p class="eyebrow">ORBIS RELAY CONSOLE</p><h1>连接背后，<br>每一处都清晰。</h1><p>查看服务运行状态，管理 Host 与设备。<br>让每一次连接，都在你的掌握之中。</p></section><section class="login-card"><h2>管理员登录</h2><p>使用服务器配置的管理员令牌登录。</p><form id="login-form"><label class="form-field" for="admin-token">管理员令牌</label><div class="password-row"><input class="field" type="password" id="admin-token" name="token" autocomplete="current-password" placeholder="输入管理员令牌" maxlength="4096" required><button class="icon-button" type="button" id="show-token" aria-pressed="false">显示</button></div><p class="error-text" role="alert" id="login-error">${escape(message)}</p><button class="button primary" id="login-submit" type="submit">进入控制台 <span aria-hidden="true">→</span></button></form><p class="footnote">仅用于 Relay 管理。邮箱激活请在 Windows Host 中完成。</p></section></main>`;
  document.getElementById("show-token").onclick = event => { const field = document.getElementById("admin-token"); const show = field.type === "password"; field.type = show ? "text" : "password"; event.currentTarget.textContent = show ? "隐藏" : "显示"; event.currentTarget.setAttribute("aria-pressed", String(show)); };
  document.getElementById("login-form").onsubmit = async event => {
    event.preventDefault(); const button = document.getElementById("login-submit"); button.disabled = true; button.textContent = "正在验证…";
    try { const session = await api("login", { method: "POST", body: JSON.stringify({ token: document.getElementById("admin-token").value }) }); document.getElementById("admin-token").value = ""; csrf = session.csrf; await enter(); }
    catch (error) { const target = document.getElementById("login-error"); if (target) target.textContent = error.message; button.disabled = false; button.textContent = "进入控制台 →"; }
  };
}
function shell() {
  app.innerHTML = `<div class="console-shell"><aside class="sidebar"><div>${brand}<p class="sidebar-caption">RELAY CONSOLE</p></div><nav class="side-nav" aria-label="控制台导航">${Object.entries(views).map(([key, [title, , symbol]]) => `<button data-view="${key}" ${key === view ? 'aria-current="page"' : ""}><span aria-hidden="true">${symbol}</span>${title}</button>`).join("")}</nav><div class="sidebar-bottom">受保护的管理会话<br>8 小时后自动过期<a href="../">访问官网 ↗</a></div></aside><main class="console-main" id="main"><header class="console-heading"><div><h1 id="view-title"></h1><p id="view-description"></p></div><div class="toolbar"><span class="status-pill" id="connection-state">● Relay 正常</span><button class="button" id="refresh">↻ 刷新</button><button class="icon-button" id="logout">退出登录</button></div></header><div id="error-banner" class="banner" role="alert" hidden></div><div id="view-content"></div><p id="freshness" class="freshness"></p></main></div>`;
  document.querySelectorAll("[data-view]").forEach(button => { button.onclick = () => switchView(button.dataset.view); });
  document.getElementById("refresh").onclick = () => refresh();
  document.getElementById("logout").onclick = async event => { event.currentTarget.disabled = true; try { await api("logout", { method: "POST" }); login(); } catch (error) { if (error.code === "unauthorized") login(); else { toast(error.message); event.currentTarget.disabled = false; } } };
}
function switchView(next) { view = next; query = ""; filter = "all"; draw(); if (view === "bandwidth" || view === "usage") void refresh(); }
function auditRows(events) {
  const labels = { "host.disable": "停用了 Host", "host.enable": "重新启用 Host", "host.reset_activation": "请求重置 Host 激活", "device.revoke": "撤销了设备 Relay 凭据", "registration.email_verification": "调整了 QQ 邮箱验证要求" };
  return events.length ? `<div class="activity-list">${events.map(event => `<div class="activity-item"><span class="activity-dot"></span><div>${escape(labels[event.action] ?? event.action)}<small>${escape(event.target)}</small></div><time>${escape(timestamp(event.at))}</time></div>`).join("")}</div>` : `<div class="empty"><strong>暂时没有管理操作</strong>停用 Host 或撤销设备后，记录会显示在这里。</div>`;
}
function overview() {
  return `<section class="metrics" aria-label="服务统计"><article class="metric"><div class="metric-label">在线 Host <span>⊞</span></div><strong>${data.hosts.online}</strong><small>${data.registration.hosts} 台已验证邮箱</small></article><article class="metric"><div class="metric-label">在线设备 <span>▯</span></div><strong>${data.devices.filter(device => device.online).length}</strong><small>共 ${data.devices.length} 个 Relay 凭据</small></article><article class="metric"><div class="metric-label">认证连接 <span>⌁</span></div><strong>${data.sockets.total}</strong><small>Host + 设备 WebSocket</small></article><article class="metric"><div class="metric-label">运行时间 <span>◷</span></div><strong>${uptime(data.uptimeSeconds)}</strong><small>从本次 Relay 启动起</small></article></section><div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h2>服务状态</h2><p>公共注册与中继服务</p></div><span class="status-pill">运行中</span></div><div class="service-rows"><div class="service-row"><span>Relay 转发</span><b>正常运行</b></div><div class="service-row"><span>QQ 邮箱注册</span><b>${data.registration.enabled ? "已配置邮件服务" : "等待配置 SMTP"}</b></div><div class="service-row"><span>构建版本</span><b>${escape(data.buildCommit ?? "本地开发")}</b></div><div class="service-row"><span>数据范围</span><b>连接与注册信息</b></div></div></section><section class="panel"><div class="panel-heading"><div><h2>你的管理边界</h2><p>保持会话内容私密</p></div></div><div class="callout"><b>Relay 不解密聊天与文件。</b><br>这里管理中继连接和注册记录。局域网与设备的最终信任关系，由电脑 Host 管理。</div></section></div><section class="panel"><div class="panel-heading"><h2>最近操作</h2><button class="icon-button" id="all-audit">查看全部 →</button></div>${auditRows(data.audit.slice(0, 5))}</section>`;
}
function service() {
  return `<div class="dashboard-grid"><section class="panel"><div class="panel-heading"><h2>注册服务</h2><span class="status-pill ${data.registration.enabled ? "" : "off"}">${data.registration.enabled ? "已启用" : "待配置"}</span></div><div class="service-rows"><div class="service-row"><span>允许邮箱域名</span><b>@qq.com</b></div><div class="service-row"><span>已验证 Host</span><b>${data.registration.hosts}</b></div><div class="service-row"><span>验证码有效期</span><b>10 分钟</b></div><div class="service-row"><span>重发间隔 / 验证上限</span><b>60 秒 / 5 次</b></div><div class="service-row"><span>会话有效期</span><b>8 小时</b></div></div></section><section class="panel"><div class="panel-heading"><h2>Relay 信息</h2></div><div class="service-rows"><div class="service-row"><span>版本</span><b>${escape(data.buildCommit ?? "本地开发")}</b></div><div class="service-row"><span>运行时间</span><b>${uptime(data.uptimeSeconds)}</b></div><div class="service-row"><span>已认证 WebSocket</span><b>${data.sockets.total}</b></div></div><code class="code-line">${escape(base.href.replace(/^http/, "ws").replace(/\/$/, ""))}</code></section></div><section class="panel settings-notes"><div class="panel-heading"><h2>配置邮件服务</h2></div><p>在服务器环境中设置 <code>ORBIS_SMTP_HOST</code>、<code>ORBIS_SMTP_PORT</code>、<code>ORBIS_SMTP_FROM</code>，以及服务商要求的 <code>ORBIS_SMTP_USER</code>、<code>ORBIS_SMTP_PASSWORD</code>，然后通过部署流程重启 Relay。</p><p>465 端口使用 TLS，其余端口要求 STARTTLS。这里的状态表示发信配置是否存在，实际投递仍需配置后验证。SMTP 密钥不会返回到浏览器。</p><p>管理员令牌使用 <code>ORBIS_ADMIN_TOKEN</code>；停用记录与最近操作存储在 <code>ORBIS_ADMIN_STATE_FILE</code>，应与 Relay 数据一起持久化。</p></section>`;
}
function registrationPolicy() {
  const required = data.registration.qqEmailVerificationRequired;
  return `<section class="panel"><div class="panel-heading"><div><h2>新 Host 激活</h2><p>此设置会立即影响新激活，现有 Host 凭据保持有效。</p></div></div><label class="policy-row" for="require-qq-email"><span><strong>要求 QQ 邮箱验证</strong><small>${required ? "开启后，新 Host 必须通过邮箱验证码激活。" : "关闭后，新 Host 可直接激活，无需填写邮箱。"}</small></span><input id="require-qq-email" type="checkbox" ${required ? "checked" : ""} aria-label="要求 QQ 邮箱验证"></label>${required && !data.registration.mailConfigured ? '<p class="policy-warning">当前尚未配置 SMTP，新 Host 暂时无法完成邮箱激活。</p>' : ""}</section>`;
}
function updateRegistrationView() {
  if (view === "service") {
    const content = document.getElementById("view-content");
    content.insertAdjacentHTML("afterbegin", registrationPolicy());
    const toggle = document.getElementById("require-qq-email");
    toggle.onchange = () => {
      const required = toggle.checked;
      toggle.checked = !required;
      confirmAction(required ? "要求 QQ 邮箱验证？" : "关闭 QQ 邮箱验证？", required ? "此后新 Host 必须通过 QQ 邮箱验证码激活。未配置 SMTP 时将无法新激活；已有 Host 凭据不受影响。" : "此后任何能访问此 Relay 的新 Host 都可直接激活，无需验证邮箱。已有 Host 凭据不受影响。", () => api("registration", { method: "POST", body: JSON.stringify({ qqEmailVerificationRequired: required }) }));
    };
  }
  for (const row of document.querySelectorAll(".service-row")) {
    const label = row.querySelector("span");
    const value = row.querySelector("b");
    if (label?.textContent === "QQ 邮箱注册") value.textContent = data.registration.qqEmailVerificationRequired ? data.registration.mailConfigured ? "邮箱验证已启用" : "等待配置 SMTP" : "可直接激活";
    if (label?.textContent === "已验证 Host") value.textContent = String(data.registration.verifiedHosts);
    if (label?.textContent === "允许邮箱域名") label.textContent = "验证邮箱域名";
  }
  const verified = document.querySelector(".metric small");
  if (view === "overview" && verified) verified.textContent = `${data.registration.verifiedHosts} 台已验证邮箱，${data.registration.hosts} 台已激活`;
}
function listPage() {
  const isHosts = view === "hosts";
  return `<section class="panel"><div class="panel-heading"><div><h2>${isHosts ? "Host 列表" : "设备列表"}</h2><p>${isHosts ? "邮箱注册的 Host 与当前可见的传统凭据 Host。停用只影响 Relay 路径。" : "撤销后设备无法再连接此 Relay；完整解除配对请在电脑 Host 操作。"}</p></div></div><div class="filter-bar"><input id="search" type="search" class="field" aria-label="搜索列表" placeholder="${isHosts ? "搜索邮箱、名称或 Host ID" : "搜索设备名称、设备 ID 或 Host"}" value="${escape(query)}"><select id="filter" class="field" aria-label="筛选状态"><option value="all">全部状态</option><option value="online">在线</option><option value="offline">离线</option>${isHosts ? '<option value="disabled">已停用</option>' : ""}</select></div><div id="table-content"></div></section>`;
}
function drawTable() {
  const isHosts = view === "hosts";
  const source = isHosts ? data.hosts.list : data.devices;
  const search = query.toLowerCase();
  const rows = source.filter(item => (filter === "all" || filter === "disabled" && item.disabled || filter === "online" && item.online || filter === "offline" && !item.online) && [item.name, item.hostId, item.email, item.deviceId].some(value => value?.toLowerCase().includes(search)));
  const content = document.getElementById("table-content");
  if (!rows.length) { content.innerHTML = `<div class="empty"><strong>${source.length ? "没有匹配结果" : isHosts ? "还没有 Host" : "还没有设备"}</strong>${source.length ? "试试其他关键词，或切换筛选条件。" : isHosts ? "Host 完成邮箱注册或连接 Relay 后，会显示在这里。" : "在 Host 中打开配对二维码，手机完成连接后会显示在这里。"}</div>`; return; }
  content.innerHTML = `<div class="table-scroll"><table><thead><tr>${isHosts ? "<th>电脑 / Host ID</th><th>注册方式</th><th>Relay 状态</th><th>设备</th><th>操作</th>" : "<th>设备 / ID</th><th>所属 Host</th><th>Relay 状态</th><th>操作</th>"}</tr></thead><tbody>${rows.map(item => isHosts ? `<tr><td><strong>${escape(item.name)}</strong><small>${escape(item.hostId)}</small></td><td>${escape(item.email ?? (item.registered ? "未验证邮箱" : "传统凭据"))}${item.verifiedAt ? `<small>${escape(timestamp(item.verifiedAt))}</small>` : ""}</td><td>${item.activationResetAt && !item.disabled ? '<span class="status-pill warn">待重新激活</span>' : badge(item.online, item.disabled)}</td><td>${item.deviceCount}</td><td><button class="row-action ${item.disabled ? "enable" : ""}" data-host="${escape(item.hostId)}">${item.disabled ? "重新启用" : "停用"}</button>${item.registered ? `<button class="row-action" data-reset-host="${escape(item.hostId)}" ${item.disabled ? "disabled" : ""}>重置激活</button>` : ""}</td></tr>` : `<tr><td><strong>${escape(item.name)}</strong><small>${escape(item.deviceId)}</small></td><td><code>${escape(item.hostId ?? "传统凭据（未绑定 Host）")}</code></td><td>${badge(item.online)}</td><td><button class="row-action" data-device="${escape(item.deviceId)}">撤销</button></td></tr>`).join("")}</tbody></table></div><p class="table-count">显示 ${rows.length} / ${source.length} 条</p>`;
  content.querySelectorAll("[data-host]").forEach(button => { button.onclick = () => {
    const host = source.find(item => item.hostId === button.dataset.host);
    confirmAction(host.disabled ? "重新启用这台 Host？" : "停用这台 Host？", `${host.name}（${host.hostId}）${host.disabled ? "将可以重新连接 Relay，原有设备凭据保留。" : "及其关联设备将立即断开 Relay。局域网配对不受此操作影响。"}`, () => api(`hosts/${encodeURIComponent(host.hostId)}`, { method: "POST", body: JSON.stringify({ disabled: !host.disabled }) }));
  }; });
  content.querySelectorAll("[data-reset-host]").forEach(button => { button.onclick = () => {
    const host = source.find(item => item.hostId === button.dataset.resetHost);
    confirmAction("重置这台电脑的激活？", `${host.name}（${host.hostId}）的旧激活凭据将立即失效。确认电脑归属后执行，用户随后可按当前注册要求重新激活。电脑身份和手机配对保留。`, () => api(`hosts/${encodeURIComponent(host.hostId)}/reset-activation`, { method: "POST", body: "{}" }));
  }; });
  content.querySelectorAll("[data-device]").forEach(button => { button.onclick = () => {
    const device = source.find(item => item.deviceId === button.dataset.device);
    confirmAction("撤销设备的 Relay 凭据？", `${device.name} 将立即断开 Relay，后续需要重新配对才能使用中继连接。如需完整撤销设备信任，请同时在电脑 Host 操作。`, () => api(`devices/${encodeURIComponent(device.deviceId)}`, { method: "DELETE" }));
  }; });
}
// X11 / RELAY-BW-01: reuse console panels, filtering and tables for device-edge telemetry.
const byteSize = value => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = value > 0 ? Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${(value / 1024 ** index).toFixed(index ? 2 : 0)} ${units[index]}`;
};
const bitRate = value => value >= 1e6 ? `${(value / 1e6).toFixed(2)} Mbps` : value >= 1e3 ? `${(value / 1e3).toFixed(2)} Kbps` : `${Math.round(value)} bps`;
const trafficCell = day => day ? `<strong>${byteSize(day.totalBytes)}</strong><small>↑ ${byteSize(day.uploadBytes)}，↓ ${byteSize(day.downloadBytes)}</small>` : "—";
const rateCell = (day, key) => day?.activeSeconds ? `<strong>${bitRate(day.combined[key])}</strong><small>↑ ${bitRate(day.upload[key])}，↓ ${bitRate(day.download[key])}</small>` : "待采样";
const bandwidthHeaders = "<th>流量</th><th>平均带宽</th><th>P95 带宽</th><th>峰值带宽</th>";
const bandwidthCells = day => `<td>${trafficCell(day)}</td><td>${rateCell(day, "meanBps")}</td><td>${rateCell(day, "p95Bps")}</td><td>${rateCell(day, "peakBps")}</td>`;
function bandwidthPage() {
  if (!bandwidthData) return '<section class="panel"><p class="loading" role="status">正在读取带宽统计…</p></section>';
  const records = bandwidthData.devices;
  const measured = records.filter(device => device[bandwidthPeriod]);
  const upload = measured.reduce((sum, device) => sum + device[bandwidthPeriod].uploadBytes, 0);
  const download = measured.reduce((sum, device) => sum + device[bandwidthPeriod].downloadBytes, 0);
  const peak = measured.reduce((max, device) => Math.max(max, device[bandwidthPeriod].combined.peakBps), 0);
  return `${bandwidthData.storageError ? '<div class="banner" role="alert">遥测文件读取或保存失败，当前统计可能不完整；请检查服务端存储。</div>' : ""}<section class="metrics" aria-label="带宽统计"><article class="metric"><div class="metric-label">上行流量</div><strong>${byteSize(upload)}</strong><small>设备 → Relay</small></article><article class="metric"><div class="metric-label">下行流量</div><strong>${byteSize(download)}</strong><small>Relay → 设备</small></article><article class="metric"><div class="metric-label">有流量的设备</div><strong>${measured.filter(device => device[bandwidthPeriod].totalBytes > 0).length}</strong><small>按 Relay 设备 ID 区分</small></article><article class="metric"><div class="metric-label">最高单设备峰值</div><strong>${bitRate(peak)}</strong><small>上下行合计，1 秒窗口</small></article></section><section class="panel"><div class="panel-heading"><div><h2>设备带宽</h2><p>流量与带宽主值为上下行合计，↑ 为上行，↓ 为下行。</p></div></div><div class="filter-bar"><input id="search" type="search" class="field" aria-label="搜索设备带宽" placeholder="搜索设备名称、设备 ID 或 Host" value="${escape(query)}"><select id="bandwidth-period" class="field" aria-label="统计时段"><option value="today">今天（UTC）</option><option value="last7Days">最近 7 天</option><option value="last30Days">最近 30 天</option></select></div><div id="bandwidth-table"></div></section><div id="bandwidth-history"></div><section class="panel settings-notes"><div class="panel-heading"><h2>统计口径</h2></div><p>仅统计在 Orbis App 设置中明确开启设备使用统计的设备；关闭后会删除该设备的详细历史。按 Relay 设备 ID 分别统计，重新配对生成新 ID。保留最近 30 个 UTC 自然日。</p><p>速率按已结束的有消息秒计算，包含认证与控制消息；无消息的空闲秒不参与。P95 为近似上界，误差不超过 4.5%；当前未结束的一秒先计入流量。</p><p>仅计设备侧 Relay 消息字节，不含局域网流量、网络协议开销及重传。QUIC 下行为 Relay 向适配器的交接量，不代表手机已收妥的速率。</p><p>${bandwidthData.persistent ? `每分钟保存一次，正常关闭时保存；异常退出可能丢失最近一分钟。上次保存：${escape(timestamp(bandwidthData.lastSavedAt))}。` : "当前仅保存在内存，重启后清空。"}</p></section>`;
}
function drawBandwidthTable() {
  const search = query.toLowerCase();
  const rows = bandwidthData.devices.filter(device => [device.name, device.deviceId, device.hostId].some(value => value?.toLowerCase().includes(search)));
  const content = document.getElementById("bandwidth-table");
  content.innerHTML = rows.length ? `<div class="table-scroll"><table><thead><tr><th>设备 / ID</th><th>Relay 状态</th>${bandwidthHeaders}<th>明细</th></tr></thead><tbody>${rows.map(device => `<tr><td><strong>${escape(device.name)}</strong><small>${escape(device.deviceId)}</small><small>${escape(device.hostId ?? "未绑定 Host")}</small></td><td>${device.revoked ? "已撤销" : badge(device.online)}</td>${bandwidthCells(device[bandwidthPeriod])}<td><button class="button" data-bandwidth-device="${escape(device.deviceId)}" aria-expanded="${bandwidthDevice === device.deviceId}">每日明细</button></td></tr>`).join("")}</tbody></table></div><p class="table-count">显示 ${rows.length} / ${bandwidthData.devices.length} 台设备</p>` : '<div class="empty"><strong>暂无设备记录</strong>设备连接 Relay 并产生流量后，即可查看统计。</div>';
  content.querySelectorAll("[data-bandwidth-device]").forEach(button => { button.onclick = () => { bandwidthDevice = bandwidthDevice === button.dataset.bandwidthDevice ? "" : button.dataset.bandwidthDevice; drawBandwidthTable(); }; });
  const selected = bandwidthData.devices.find(device => device.deviceId === bandwidthDevice);
  document.getElementById("bandwidth-history").innerHTML = selected ? `<section class="panel"><div class="panel-heading"><div><h2>${escape(selected.name)} 每日明细</h2><p>最近 30 天有流量的日期（UTC），首次采集 ${escape(timestamp(selected.firstSeenAt))}，最近流量 ${escape(timestamp(selected.lastSeenAt))}</p></div></div>${selected.days?.length ? `<div class="table-scroll"><table><thead><tr><th>日期（UTC）</th>${bandwidthHeaders}</tr></thead><tbody>${selected.days.map(day => `<tr><td>${escape(day.date)}</td>${bandwidthCells(day)}</tr>`).join("")}</tbody></table></div>` : '<div class="empty">尚未收到这台设备的流量。</div>'}</section>` : "";
}
const usageGranularityLabels = { hour: "小时", day: "日", week: "周", fortnight: "双周", month: "月" };
const usageDuration = seconds => seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${(seconds / 60).toFixed(1)} 分钟` : `${(seconds / 3600).toFixed(1)} 小时`;
const usageTime = value => {
  if (!value) return "—";
  const date = new Date(value);
  return usageGranularity === "hour" ? `${date.toISOString().slice(0, 13).replace("T", " ")}:00Z` : date.toISOString().slice(0, 10);
};
const metricValue = (row, key) => Number(row?.[key] ?? 0);
const usageRate = row => row?.bandwidth?.combined ? `${bitRate(row.bandwidth.combined.meanBps)} / ${bitRate(row.bandwidth.combined.p95Bps)} / ${bitRate(row.bandwidth.combined.peakBps)}` : "—";
function usagePage() {
  if (!usageData) return '<section class="panel"><p class="loading" role="status">正在读取增长遥测…</p></section>';
  const latest = usageData.aggregate.at(-1) ?? {};
  const activeLabel = ({ hour: "本小时活跃设备", day: "DAU", week: "WAU", fortnight: "14 日活跃设备", month: "MAU" })[usageGranularity];
  const periodOptions = Object.entries(usageGranularityLabels).map(([key, label]) => `<option value="${key}">${label}粒度</option>`).join("");
  const rows = usageData.aggregate ?? [];
  const userRows = (usageData.users ?? []).filter(user => [user.name, user.deviceId, user.hostId].some(value => value?.toLowerCase().includes(query.toLowerCase())));
  const aggregateTable = rows.length ? `<div class="table-scroll"><table><thead><tr><th>时段（UTC）</th><th>活跃</th><th>新增</th><th>回访</th><th>会话</th><th>连接时长</th><th>消息</th><th>上行</th><th>下行</th><th>网站访问</th><th>下载次数 / 字节</th><th>注册申请</th><th>配对码</th><th>新配对</th><th>新 Host</th></tr></thead><tbody>${[...rows].reverse().map(row => `<tr><td>${escape(usageTime(row.bucketStart))}</td><td>${metricValue(row, "activeUsers")}</td><td>${metricValue(row, "newUsers")}</td><td>${metricValue(row, "returningUsers")}</td><td>${metricValue(row, "sessions")}</td><td>${escape(usageDuration(metricValue(row, "connectedSeconds")))}</td><td>${metricValue(row, "messages")}</td><td>${escape(byteSize(metricValue(row, "uploadBytes")))}</td><td>${escape(byteSize(metricValue(row, "downloadBytes")))}</td><td>${metricValue(row, "websitePageViews")}</td><td>${metricValue(row, "downloadRequests")} / ${escape(byteSize(metricValue(row, "downloadBytesServed")))}</td><td>${metricValue(row, "registrationStarts")}</td><td>${metricValue(row, "pairingCodes")}</td><td>${metricValue(row, "pairedDevices")}</td><td>${metricValue(row, "newHostRegistrations")}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty"><strong>尚无该粒度数据</strong>部署后开始记录，不会回填部署前的历史。</div>';
  const devicesTable = userRows.length ? `<div class="table-scroll"><table><thead><tr><th>设备 / 用户代理</th><th>状态</th><th>活跃</th><th>新增 / 回访</th><th>会话</th><th>连接时长</th><th>消息</th><th>流量</th><th>平均 / P95 / 峰值带宽</th><th>明细</th></tr></thead><tbody>${userRows.map(user => { const row = user.metrics ?? {}; return `<tr><td><strong>${escape(user.name)}</strong><small>${escape(user.deviceId)}</small><small>${escape(user.hostId ?? "未绑定 Host")}</small></td><td>${user.revoked ? "已撤销" : badge(user.online)}</td><td>${metricValue(row, "activeUsers")}</td><td>${metricValue(row, "newUsers") ? "新增" : metricValue(row, "returningUsers") ? "回访" : "—"}</td><td>${metricValue(row, "sessions")}</td><td>${escape(usageDuration(metricValue(row, "connectedSeconds")))}</td><td>${metricValue(row, "messages")}</td><td>${escape(byteSize(metricValue(row, "totalBytes")))}</td><td>${escape(usageRate(row))}</td><td><button class="button" data-usage-device="${escape(user.deviceId)}">时序</button></td></tr>`; }).join("")}</tbody></table></div>` : '<div class="empty"><strong>暂无设备</strong></div>';
  const resourceTable = rows.length ? `<div class="table-scroll"><table><thead><tr><th>时段（UTC）</th><th>采样</th><th>CPU 平均 / 峰值</th><th>RSS 平均 / 峰值</th><th>Heap 平均 / 峰值</th><th>设备连接峰值</th><th>Host 连接峰值</th><th>事件循环延迟峰值</th></tr></thead><tbody>${[...rows].reverse().map(row => { const r = row.resources ?? {}; return `<tr><td>${escape(usageTime(row.bucketStart))}</td><td>${metricValue(r, "sampleCount")}</td><td>${metricValue(r, "cpuPercentAverage").toFixed(1)}% / ${metricValue(r, "cpuPercentPeak").toFixed(1)}%</td><td>${escape(byteSize(metricValue(r, "rssBytesAverage")))} / ${escape(byteSize(metricValue(r, "rssBytesPeak")))}</td><td>${escape(byteSize(metricValue(r, "heapUsedBytesAverage")))} / ${escape(byteSize(metricValue(r, "heapUsedBytesPeak")))}</td><td>${metricValue(r, "connectedDevicesPeak")}</td><td>${metricValue(r, "connectedHostsPeak")}</td><td>${metricValue(r, "eventLoopP95MsPeak").toFixed(1)} / ${metricValue(r, "eventLoopMaxMsPeak").toFixed(1)} ms</td></tr>`; }).join("")}</tbody></table></div>` : '<div class="empty">等待资源采样。</div>';
  const cohortTable = usageData.cohorts?.length ? `<div class="table-scroll"><table><thead><tr><th>首次活跃日期</th><th>新增设备</th><th>D1 留存</th><th>D7 留存</th><th>D30 留存</th></tr></thead><tbody>${usageData.cohorts.map(row => { const age = Math.floor((Date.now() - Date.parse(`${row.date}T00:00:00Z`)) / 86400000); const rate = (count, mature) => mature && row.users ? `${count} / ${row.users}（${(count * 100 / row.users).toFixed(1)}%）` : "未成熟"; return `<tr><td>${escape(row.date)}</td><td>${row.users}</td><td>${rate(row.day1Retained, age >= 2)}</td><td>${rate(row.day7Retained, age >= 8)}</td><td>${rate(row.day30Retained, age >= 31)}</td></tr>`; }).join("")}</tbody></table></div>` : '<div class="empty">首次活跃用户出现后生成留存 cohort。</div>';
  const historyTable = usageHistory.length ? `<section class="panel"><div class="panel-heading"><div><h2>${escape(usageHistory[0]?.name ?? "设备")} 历史时序</h2><p>按 ${usageGranularityLabels[usageGranularity]} 直接读取已存储的预聚合行。</p></div><button class="button" id="close-usage-history">收起</button></div><div class="table-scroll"><table><thead><tr><th>时段（UTC）</th><th>会话</th><th>连接时长</th><th>消息</th><th>上行</th><th>下行</th><th>平均 / P95 / 峰值带宽</th></tr></thead><tbody>${usageHistory.map(row => `<tr><td>${escape(usageTime(row.bucketStart))}</td><td>${metricValue(row, "sessions")}</td><td>${escape(usageDuration(metricValue(row, "connectedSeconds")))}</td><td>${metricValue(row, "messages")}</td><td>${escape(byteSize(metricValue(row, "uploadBytes")))}</td><td>${escape(byteSize(metricValue(row, "downloadBytes")))}</td><td>${escape(usageRate(row))}</td></tr>`).join("")}</tbody></table></div></section>` : "";
  return `<section class="metrics" aria-label="增长与用量"><article class="metric"><div class="metric-label">${activeLabel}</div><strong>${metricValue(latest, "activeUsers")}</strong><small>Relay 设备 ID 代理，不等于自然人账号</small></article><article class="metric"><div class="metric-label">新增活跃设备</div><strong>${metricValue(latest, "newUsers")}</strong><small>本粒度首次被观察到活跃</small></article><article class="metric"><div class="metric-label">回访设备</div><strong>${metricValue(latest, "returningUsers")}</strong><small>本粒度此前已活跃</small></article><article class="metric"><div class="metric-label">网站访问</div><strong>${metricValue(latest, "websitePageViews")}</strong><small>主页成功 GET；不是独立访客数</small></article></section><section class="panel"><div class="panel-heading"><div><h2>增长与使用总表</h2><p>注册、配对、活跃、消息、流量及网站下载漏斗。</p></div></div><div class="filter-bar"><select id="usage-granularity" class="field" aria-label="统计粒度">${periodOptions}</select></div>${aggregateTable}</section><section class="panel"><div class="panel-heading"><div><h2>设备使用明细</h2><p>连接时长包括已认证 WebSocket 的空闲连接；带宽按有消息秒统计。</p></div></div><div class="filter-bar"><input id="usage-search" type="search" class="field" aria-label="搜索设备遥测" placeholder="搜索设备名称、ID 或 Host" value="${escape(query)}"></div>${devicesTable}</section>${historyTable}<section class="panel"><div class="panel-heading"><div><h2>服务器资源</h2><p>每分钟采样，展示各粒度的平均值与峰值。</p></div></div>${resourceTable}</section><section class="panel"><div class="panel-heading"><div><h2>用户留存 cohort</h2><p>以首次活跃 UTC 日期分组，统计 D1、D7、D30 当日回访。</p></div></div>${cohortTable}</section><section class="panel settings-notes"><div class="panel-heading"><h2>统计口径与范围</h2></div><p>表行由 Relay 事件实时更新，SQLite 保存小时、日、周、双周、月预聚合；后台读取行，不在请求时扫描事件重算。</p><p>周以 UTC 周一开始；双周按 1970-01-05 UTC 起始的固定 14 天对齐；月为 UTC 自然月。小时保留 90 天、日 400 天、周和双周 3 年、月 5 年。</p><p>设备使用明细仅包含在 Orbis App 设置中明确允许统计的设备；关闭后会删除其可识别的明细，聚合服务总量保留。Relay 仍统计主页访问、下载总量、注册与配对码事件，以及每分钟 CPU、内存、连接数和事件循环指标。网站访问只记录成功的主页 GET，下载只记录 Relay 实际成功服务的类别与字节数；不保存 IP、Cookie、设备消息内容或 URL 查询参数。</p><p>遥测采集开始于 ${escape(timestamp(usageData.coverageStartedAt))}。网站访问不识别独立访客；设备 ID 不能证明自然人身份；设备级使用明细只包含明确同意的设备。QUIC 或由外部 Nginx 直接提供的下载不计入 Relay WebSocket / 下载字节口径。</p></section>`;
}
async function loadUsageDevice(deviceId) {
  usageDevice = deviceId;
  try {
    const result = await api(`usage?granularity=${encodeURIComponent(usageGranularity)}&deviceId=${encodeURIComponent(deviceId)}`);
    usageHistory = result.deviceHistory ?? [];
    draw();
  } catch (error) {
    if (error.code === "unauthorized") login(error.message);
    else toast(error.message);
  }
}
function drawUsageUsers() {
  const input = document.getElementById("usage-search");
  if (input) input.oninput = event => { query = event.target.value; draw(); };
  const selector = document.getElementById("usage-granularity");
  if (selector) { selector.value = usageGranularity; selector.onchange = () => { usageGranularity = selector.value; usageHistory = []; usageDevice = ""; void refresh(); }; }
  document.querySelectorAll("[data-usage-device]").forEach(button => { button.onclick = () => void loadUsageDevice(button.dataset.usageDevice); });
  const close = document.getElementById("close-usage-history");
  if (close) close.onclick = () => { usageDevice = ""; usageHistory = []; draw(); };
}

function confirmAction(title, message, action) {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-message").textContent = message;
  document.getElementById("confirm-error").textContent = "";
  document.getElementById("cancel-action").onclick = () => dialog.close();
  const button = document.getElementById("confirm-action"); button.disabled = false;
  button.onclick = async () => {
    mutation = true; button.disabled = true;
    try { await action(); dialog.close(); toast("操作已完成"); await refresh(); }
    catch (error) { if (error.code === "unauthorized") login(error.message); else document.getElementById("confirm-error").textContent = error.message; }
    finally { mutation = false; button.disabled = false; }
  };
  dialog.showModal(); document.getElementById("cancel-action").focus();
}
function draw() {
  if (!data || !document.getElementById("view-content")) return;
  document.getElementById("view-title").textContent = views[view][0];
  document.getElementById("view-description").textContent = views[view][1];
  document.querySelectorAll("[data-view]").forEach(button => { if (button.dataset.view === view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
  document.getElementById("view-content").innerHTML = view === "overview" ? overview() : view === "bandwidth" ? bandwidthPage() : view === "usage" ? usagePage() : view === "service" ? service() : view === "audit" ? `<section class="panel"><div class="panel-heading"><h2>管理操作记录</h2></div>${auditRows(data.audit)}</section>` : listPage();
  updateRegistrationView();
  if (view === "usage" && usageData) drawUsageUsers();
  if (view === "bandwidth" && bandwidthData) {
    document.getElementById("search").oninput = event => { query = event.target.value; drawBandwidthTable(); };
    const period = document.getElementById("bandwidth-period");
    period.value = bandwidthPeriod;
    period.onchange = () => { bandwidthPeriod = period.value; draw(); };
    drawBandwidthTable();
  }
  if (view === "overview") document.getElementById("all-audit").onclick = () => switchView("audit");
  if (view === "hosts" || view === "devices") {
    document.getElementById("search").oninput = event => { query = event.target.value; drawTable(); };
    document.getElementById("filter").value = filter;
    document.getElementById("filter").onchange = event => { filter = event.target.value; drawTable(); };
    drawTable();
  }
  document.getElementById("freshness").textContent = `上次更新 ${timestamp(lastRefresh)}，概览与用量每 30 秒刷新`;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const requestedBandwidth = view === "bandwidth";
  const requestedUsage = view === "usage";
  const button = document.getElementById("refresh"); if (button) button.disabled = true;
  try {
    const [next, traffic, usage] = await Promise.all([api("overview"), requestedBandwidth ? api("bandwidth") : Promise.resolve(bandwidthData), requestedUsage ? api(`usage?granularity=${encodeURIComponent(usageGranularity)}`) : Promise.resolve(usageData)]); if (!csrf) return; data = next; bandwidthData = traffic; usageData = usage; lastRefresh = Date.now();
    document.getElementById("error-banner").hidden = true;
    document.getElementById("connection-state").textContent = "● Relay 正常";
    document.getElementById("connection-state").className = "status-pill";
    draw();
  } catch (error) {
    if (error.code === "unauthorized") login(error.message);
    else { const banner = document.getElementById("error-banner"); if (banner) { banner.textContent = `${error.message} 当前保留上次成功读取的数据。`; banner.hidden = false; document.getElementById("connection-state").textContent = "连接异常"; document.getElementById("connection-state").className = "status-pill warn"; } }
  } finally { refreshing = false; if (button) button.disabled = false; if (!requestedBandwidth && view === "bandwidth" && !bandwidthData || !requestedUsage && view === "usage" && !usageData) void refresh(); }
}
async function enter() {
  [data, bandwidthData, usageData] = await Promise.all([api("overview"), view === "bandwidth" ? api("bandwidth") : Promise.resolve(undefined), view === "usage" ? api(`usage?granularity=${encodeURIComponent(usageGranularity)}`) : Promise.resolve(undefined)]); lastRefresh = Date.now(); shell(); draw(); clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden && !mutation && !dialog.open && !document.querySelector(".filter-bar")?.contains(document.activeElement) && (view === "overview" || view === "bandwidth" || view === "usage")) void refresh(); }, 30000);
}
async function initialize() {
  try { const session = await api("session"); csrf = session.csrf; await enter(); }
  catch (error) { login(error.code === "unauthorized" ? "" : error.message); }
}
window.addEventListener("pageshow", event => { if (event.persisted) { clearInterval(timer); app.innerHTML = '<p class="loading">正在检查登录状态…</p>'; void initialize(); } });
void initialize();
