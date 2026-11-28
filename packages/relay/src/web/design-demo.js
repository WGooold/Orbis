/* Local interactive versions of the current Orbis Agent dial, multi-format preview, privacy E2EE, draft and session flows. */
window.OrbisDemoPolicy = {
  draftAction(text) { return text.trim() ? { label: "发送第一句话", icon: "arrow-up" } : { label: "启动", icon: "play" }; },
  swipeArmed(distance, width) { return distance >= width * 0.4; },
  dialGeometry(width = 393, height = 360) {
    const r0 = Math.max(140, Math.min(Math.round(width * 0.52), Math.floor(height / 2) - 28, width - 76 - 28 - 136));
    const rim = r0 + Math.round(Math.max(22, Math.min(30, r0 * 0.15))) + 24, radius = Math.round(r0 * 1.6), cx = rim - radius, cy = height / 2;
    const hole = Math.max(Math.round(Math.max(22, Math.min(44, radius * 0.15))), 26 - cx), hub = Math.max(Math.round(radius * 0.5), hole + 72);
    const agentRadius = Math.round((hole + hub) / 2) + 2;
    const seam = hub + 24;
    const pinStart = cx + agentRadius;
    const pinTravel = seam - agentRadius;
    return {
      width, height, rim, radius, cx, cy, hole, hub, seam, agentRadius,
      step: Math.round(Math.max(16, Math.min(24, 96 / (radius + 28) * 180 / Math.PI))),
      agentStep: Math.round(Math.max(24, Math.min(40, 56 / agentRadius * 180 / Math.PI))),
      pinStart, pinTravel, pinChannelLeft: pinStart - 22, pinChannelWidth: pinTravel + 44,
    };
  },
  dialLayer(x, y, touch, geometry) {
    if (touch && x < 20) return null;
    const g = geometry || this.dialGeometry(), distance = Math.hypot(x - g.cx, y - g.cy);
    return distance < g.hole ? null : distance < g.hub ? "agent" : distance < g.seam ? null : "profile";
  },
  dialInPinChannel(x, y, geometry) {
    const g = geometry || this.dialGeometry();
    return x >= g.pinStart - 22 && x <= g.pinStart + g.pinTravel + 22 && Math.abs(y - g.cy) <= 26;
  },
  dialPinHorizontal(dx, dy) { return Math.abs(dx) > Math.abs(dy) * 1.1; },
  dialPinDrag(enabled, dx, travel) { return Math.max(0, Math.min(1, (enabled ? 1 : 0) + dx / travel)); },
  dialPinArmed(enabled, position) { return enabled ? position < 0.5 : position > 0.5; },
  dialPinReleaseHint(enabled, activeSessions = 0) {
    if (!enabled) return "松手启用";
    return activeSessions > 0 ? "松手后确认停用" : "松手停用";
  },
  dialDocked(distance) { const t = Math.max(0, Math.min(1, Math.abs(distance) / 0.2)); return 1 - t * t * (3 - 2 * t); },
  dialSeated(distance) { const t = Math.max(0, Math.min(1, Math.abs(distance) / 0.1)); return 1 - t * t * (3 - 2 * t); },
  dialGate(distance) { const t = Math.max(0, Math.min(1, Math.abs(distance) / 0.5)); return 1 - t * t * (3 - 2 * t); },
  dialPinCentre(geometry, distance, travel) {
    const g = geometry || this.dialGeometry();
    const angle = distance * g.agentStep * Math.PI / 180;
    const dock = this.dialDocked(distance);
    const radius = g.agentRadius + Math.max(0, Math.min(1, travel)) * this.dialSeated(distance) * g.pinTravel;
    return { x: g.cx + radius * Math.cos(angle), y: g.cy + radius * Math.sin(angle) * (1 - dock) };
  },
  dialIndex(layer, start, distance, count = 4) {
    return Math.max(0, Math.min(count - 1, start + Math.round(-distance / (layer === "agent" ? 84 : 96))));
  },
  dialRelease(layer, position, velocity, count = 4) {
    return Math.max(0, Math.min(count - 1, Math.round(position + (layer === "profile" ? velocity * 140 : 0))));
  },
  profileAction(agent, active, moving) {
    const pi = agent === 0 || agent === "pi";
    return { disabled: moving || (!pi && active), label: pi ? (active ? "移出 " : "启用 ") : active ? "正在使用 " : "切换到 " };
  },
};

window.createOrbisDesignDemo = function ({ screen, scene, reduced, onPlayback, onPage }) {
  const policy = window.OrbisDemoPolicy;
  const agents = [
    { id: "pi", kind: "pi", name: "Pi", icon: "pi.svg" },
    { id: "codex", kind: "codex", name: "Codex", icon: "codex.svg" },
    { id: "deepseek", kind: "dsh", name: "DeepSeek CLI", icon: "deepseek.svg" },
    { id: "claude", kind: "claude", name: "Claude Code", icon: "lobe-claudecode-color.svg" },
    { id: "deepseek", kind: "dshDesktop", name: "DeepSeek 桌面版", icon: "deepseek.svg" },
    { id: "kimi", kind: "kimiCode", name: "Kimi Code Web", icon: "kimi-code.svg" },
    { id: "kimi", kind: "kimiCodeDesktop", name: "Kimi Code 桌面版", icon: "kimi-code.svg" },
    { id: "opencode", kind: "opencode", name: "OpenCode", icon: "opencode-light.svg", darkIcon: "opencode-dark.svg" },
    { id: "agy", kind: "agy", name: "Antigravity CLI", icon: "antigravity.svg" },
    { id: "hermes", kind: "hermes", name: "Hermes Agent", icon: "lobe-hermesagent.svg" },
    { id: "openclaw", kind: "openclaw", name: "OpenClaw", icon: "lobe-openclaw-color.svg" },
  ];
  const draftSources = [
    { kind: "codex", index: 1, variant: "terminal" },
    { kind: "codexDesktop", index: 1, variant: "desktop" },
    ...[3, 2, 4, 0, 5, 6, 7, 8, 9, 10].map(index => ({ kind: agents[index].kind, index })),
  ];
  const agentOrder = [1, 3, 2, 0];
  /* All 12 Host catalog entries in the exact agentEnablementOrder for the upgraded Agent dial. */
  const dialAgents = [
    { kind: "codex", brand: "codex", title: "Codex", label: "Codex CLI", icon: "codex.svg", variant: "terminal", group: "codex", enabled: true, status: "已连接", tone: "success", sessions: ["配置 iOS 应用 TestFlight 上传", "修复 QUIC 重连后的历史停顿"] },
    { kind: "codexDesktop", brand: "codex", title: "Codex Desktop", label: "Codex Desktop", icon: "codex.svg", variant: "desktop", group: "codex", enabled: true, status: "已连接", tone: "success", sessions: ["核对下载页与动效参数"] },
    { kind: "claude", brand: "claude", title: "Claude Code", label: "Claude Code", icon: "lobe-claudecode-color.svg", variant: null, group: "claude", enabled: true, status: "已连接", tone: "success", sessions: ["新拟物菜单栏设计稿实现"] },
    { kind: "dsh", brand: "deepseek", title: "DeepSeek", label: "DeepSeek CLI", icon: "deepseek.svg", variant: "terminal", group: "dsh", enabled: true, status: "可启动", tone: "neutral", sessions: [] },
    { kind: "dshDesktop", brand: "deepseek", title: "DeepSeek Desktop", label: "DeepSeek Desktop", icon: "deepseek.svg", variant: "desktop", group: null, enabled: false, status: "未启用", tone: "neutral", sessions: [] },
    { kind: "pi", brand: "pi", title: "Pi", label: "Pi", icon: "pi.svg", variant: null, group: "pi", enabled: true, status: "已连接", tone: "success", sessions: ["整理下载记录与回收空间"] },
    { kind: "kimiCode", brand: "kimi", title: "Kimi Code Web", label: "Kimi Code Web", icon: "kimi-code.svg", variant: "web", group: null, enabled: true, status: "可启动", tone: "neutral", sessions: [] },
    { kind: "kimiCodeDesktop", brand: "kimi", title: "Kimi Code 桌面版", label: "Kimi Code 桌面版", icon: "kimi-code.svg", variant: "desktop", group: null, enabled: false, status: "未启用", tone: "neutral", sessions: [] },
    { kind: "opencode", brand: "opencode", title: "OpenCode", label: "OpenCode", icon: "opencode-light.svg", darkIcon: "opencode-dark.svg", variant: null, group: null, enabled: true, status: "已连接", tone: "success", sessions: ["梳理文档与接口索引"] },
    { kind: "agy", brand: "agy", title: "Antigravity CLI", label: "Antigravity CLI", icon: "antigravity.svg", variant: null, group: "agy", enabled: true, status: "已连接", tone: "success", sessions: [] },
    { kind: "hermes", brand: "hermes", title: "Hermes Agent", label: "Hermes Agent", icon: "lobe-hermesagent.svg", variant: null, group: null, enabled: false, status: "未启用", tone: "neutral", sessions: [] },
    { kind: "openclaw", brand: "openclaw", title: "OpenClaw", label: "OpenClaw", icon: "lobe-openclaw-color.svg", variant: null, group: null, enabled: true, status: "已连接", tone: "success", sessions: ["巡检夜间构建任务"] },
  ];
  const providerCatalog = {
    codex: [
      { id: "native", name: "本机配置", official: true, subscription: true, fiveHour: 86, fiveReset: "2 小时 14 分后重置", sevenDay: 41, sevenReset: "11 月 29 日 09:00 重置" },
      { id: "relay-b", name: "relay-b", official: false, subscription: false },
      { id: "openrouter", name: "openrouter", official: false, subscription: false },
      { id: "azure", name: "azure", official: false, subscription: false },
    ],
    claude: [
      { id: "native", name: "本机配置", official: true, subscription: true, fiveHour: 63, fiveReset: "3 小时 5 分后重置", sevenDay: 18, sevenReset: "11 月 30 日 21:00 重置" },
      { id: "relay-b", name: "relay-b", official: false, subscription: false },
      { id: "openrouter", name: "openrouter", official: false, subscription: false },
      { id: "azure", name: "azure", official: false, subscription: false },
    ],
    dsh: [
      { id: "native", name: "官方配置", official: true, subscription: false },
      { id: "relay-b", name: "relay-b", official: false, subscription: false },
      { id: "openrouter", name: "openrouter", official: false, subscription: false },
    ],
    pi: [
      { id: "native", name: "本机配置", official: true, subscription: false },
      { id: "relay-b", name: "relay-b", official: false, subscription: false },
      { id: "openrouter", name: "openrouter", official: false, subscription: false },
      { id: "azure", name: "azure", official: false, subscription: false },
    ],
    agy: [
      { id: "google", name: "Google 账号", official: true, subscription: true, readOnly: true, fiveHour: 92, fiveReset: "4 小时 10 分后重置", sevenDay: 74, sevenReset: "12 月 2 日 18:00 重置" },
    ],
  };
  const appearance = window.orbisAppearance;
  const currentAppearance = () => appearance?.current() || { material: "mist", mode: "system", dark: false };
  const root = document.createElement("div"); root.className = "design-demo"; root.id = "design-demo";
  const chrome = [...screen.querySelectorAll("#s4-home > .ui-time,#s4-home > .ui-sys")].map(el => el.outerHTML).join("");
  const esc = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const svg = (path, size = 18) => `<svg class="demo-svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const icon = name => {
    if (name === "play") return `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
    if (name === "power") return svg('<path d="M12 3v9"/><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>', 18);
    if (name === "swap") return svg('<path d="M7 16 3 12l4-4"/><path d="M3 12h18"/><path d="m17 8 4 4-4 4"/>', 18);
    if (name === "terminal") return svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>', 10);
    if (name === "desktop-mini") return svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/>', 10);
    if (name === "web-mini") return svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a13 13 0 0 1 0 18"/><path d="M12 3a13 13 0 0 0 0 18"/>', 10);
    return `<i class="ico i-${name}" aria-hidden="true"></i>`;
  };
  const mark = agent => ["codex", "deepseek", "pi", "claude"].includes(agent.id || agent.brand)
    ? `<span class="demo-agentmark demo-mark-${agent.id || agent.brand}" aria-hidden="true"></span>`
    : `<span class="demo-agentmark demo-agent-image" aria-hidden="true"><img src="assets/promo/agents/${agent.icon}" alt="" class="${agent.darkIcon ? "agent-mark-on-light" : ""}">${agent.darkIcon ? `<img src="assets/promo/agents/${agent.darkIcon}" alt="" class="agent-mark-on-dark">` : ""}</span>`;
  const button = (action, label, name, extra = "") => `<button type="button" class="demo-icon" data-demo-action="${action}" aria-label="${label}" ${extra}>${icon(name)}</button>`;
  const codexName = variant => variant === "desktop" ? "Codex 桌面版" : "Codex 终端版";
  const sessionAgentName = session => session.agent === 1 ? codexName(session.codexVariant) : agents[session.agent].name;
  const protocolName = value => ({ auto: "自动", ws: "WebSocket", quic: "QUIC" })[value];

  const state = {
    codexVariant: "terminal", codexMenu: null, agentSheet: false, draftAgent: 1, protocolInfo: false,
    page: scene === "agent" ? "providers" : "home",
    draft: false, text: "", directory: "/Projects/orbis",
    dialIndex: 0,
    profileByGroup: { codex: 0, claude: 0, dsh: 0, pi: 0, agy: 0 },
    activeByGroup: { codex: 0, claude: 0, dsh: 0, pi: 0, agy: 0 },
    piEnabled: new Set([0]),
    dialHint: "",
    dialFx: "",
    pinArmed: false,
    drawer: false, search: "", expanded: new Set(["/Projects/orbis"]), selected: new Set(),
    moving: false, dialog: null, disableTarget: null,
    protocolSheet: false, languageSheet: false, language: "system", draftLanguage: "system",
    directorySheet: false, protocol: "auto", draftProtocol: "auto",
    notice: "", undoKind: null,
  };
  let sessions = [
    { id: 1, title: "统一子代理逻辑并添加界面提示", directory: "/Projects/orbis", agent: 2, status: "运行中", tone: "success", syncing: true },
    { id: 2, title: "配置 iOS 应用 TestFlight 上传", directory: "/Projects/orbis", agent: 1 },
    { id: 3, title: "新拟物菜单栏设计稿实现", directory: "/Projects/orbis", agent: 3, status: "等待审批", tone: "warning" },
    { id: 4, title: "整理下载记录与回收空间", directory: "/Projects/website", agent: 0 },
    { id: 5, title: "修复 QUIC 重连后的历史停顿", directory: "/Projects/orbis", agent: 1 },
  ];
  let nextId = 6, gesture, selectionHold, dialAnimation = 0, pinAnimation = 0, hintTimer = 0, fxTimer = 0, playback = [], animations = [], playing = false, disposed = false, suppressClick = false;
  const $ = selector => root.querySelector(selector);
  const duration = ms => reduced() ? 0 : ms;
  const currentDialAgent = () => dialAgents[state.dialIndex];
  const currentProfiles = agent => agent.enabled && agent.group ? providerCatalog[agent.group] : [];
  const currentProfileIndex = agent => agent.group ? (state.profileByGroup[agent.group] ?? 0) : 0;
  const isProfileActive = (agent, index) => agent.group === "pi" ? state.piEnabled.has(index) : state.activeByGroup[agent.group] === index;

  function motion(element, frames, ms, easing = "cubic-bezier(.2,0,0,1)") {
    if (!element || !element.animate) return Promise.resolve();
    const animation = element.animate(frames, { duration: duration(ms), easing }); animations.push(animation);
    return animation.finished.catch(() => {});
  }
  function stopPlayback() {
    playback.forEach(window.clearTimeout); playback = [];
    animations.forEach(animation => animation.cancel()); animations = [];
    playing = false; onPlayback(false);
  }
  function render() {
    if (disposed) return;
    const focusedLayer = !state.dialog && !state.drawer && !state.agentSheet && !state.protocolSheet && !state.languageSheet && !state.directorySheet
      ? document.activeElement?.closest?.("[data-dial-layer]")?.dataset?.dialLayer
      : null;
    const dialAgent = currentDialAgent();
    root.dataset.agent = state.draft ? agents[state.draftAgent].id : dialAgent.brand;
    root.dataset.kind = dialAgent.kind;
    root.dataset.page = state.page;
    root.dataset.selecting = String(state.selected.size > 0);
    root.dataset.moving = String(state.moving);
    onPage?.(state.page);
    root.innerHTML = chrome +
      `<div class="demo-content" ${state.agentSheet ? "inert" : ""}>${state.page === "home" ? home() : state.page === "providers" ? providers() : state.page === "settings" ? settings() : state.page === "downloads" ? downloads() : chat()}</div>` +
      `${state.drawer ? drawer() : ""}` +
      `${state.codexMenu ? `<div class="demo-menu-scrim" data-demo-action="codex-menu-close"></div>` : ""}` +
      `${state.dialog === "provider" ? confirmation() : state.dialog === "disable" ? disableConfirmation() : ""}` +
      `${state.protocolSheet ? protocolSheet() : ""}${state.languageSheet ? languageSheet() : ""}${state.protocolInfo ? protocolInfo() : ""}${state.directorySheet ? directorySheet() : ""}${state.agentSheet ? agentSheet() : ""}` +
      `${state.notice ? `<div class="demo-notice" role="status"><span>${esc(state.notice)}</span>${state.undoKind ? `<button type="button" class="demo-notice-undo" data-demo-action="agent-undo">撤销</button>` : ""}${button("notice-close", "关闭提示", "close")}</div>` : ""}` +
      `<div class="film-home-indicator"></div>`;
    layoutDial();
    for (const el of root.querySelectorAll("[data-remaining]")) el.style.width = `${el.dataset.remaining}%`;
    if (focusedLayer) root.querySelector(`[data-dial-layer="${focusedLayer}"]`)?.focus({ preventScroll: true });
  }
  function home() {
    return `<header class="demo-topbar">${button("drawer-open", "打开会话目录", "menu")}<div class="demo-wordmark"><b>Orbis</b><small>Nothing But the Remote</small></div>${button("downloads", "下载", "download")}${button("draft-toggle", state.draft ? "收起草稿" : "新建会话", state.draft ? "close" : "plus")}</header><div class="demo-home-scroll"><div class="demo-computer">${icon("desktop")}<strong>workstation</strong><span class="demo-connected"><i class="demo-dot"></i>局域网${icon("lock")}</span></div>${state.selected.size ? `<div class="demo-batch"><span>已选择 ${state.selected.size} 项</span><button type="button" class="demo-text-button danger" data-demo-action="close-selected">关闭会话</button><button type="button" class="demo-text-button" data-demo-action="selection-cancel">取消</button></div>` : ""}${state.draft ? draft() : ""}<div class="demo-session-list">${sessions.map(session => sessionCard(session)).join("")}</div></div>${tabs("home")}`;
  }
  function sessionCard(session) {
    const agent = agents[session.agent];
    return `<div class="demo-session-wrap"><div class="demo-swipe-feedback" aria-hidden="true"><span class="demo-swipe-seat">${icon("close")}<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" pathLength="100"></circle></svg></span><span class="demo-swipe-label">关闭</span></div><article class="demo-session" role="button" tabindex="0" data-session="${session.id}" aria-label="${esc(session.title)}，${sessionAgentName(session)}，${session.status || "空闲"}" aria-pressed="${state.selected.has(session.id)}"><span class="demo-emblem">${mark(agent)}</span><div class="demo-session-text"><strong>${esc(session.title)}</strong><code>${esc(session.directory)}</code><span><b class="agent-${agent.id}">${sessionAgentName(session)}</b><i class="demo-dot ${session.syncing ? "syncing" : session.tone || "idle"}"></i>${session.status || "空闲"}</span></div><button type="button" class="demo-session-select" data-demo-action="select-session" data-id="${session.id}" aria-label="${state.selected.has(session.id) ? "取消选择" : "选择"} ${esc(session.title)}">${icon(state.selected.has(session.id) ? "check" : "more")}</button></article></div>`;
  }
  function draft() {
    const action = policy.draftAction(state.text);
    const draftName = state.draftAgent === 1 ? codexName(state.codexVariant) : agents[state.draftAgent].name;
    return `<section class="demo-draft" aria-label="新建会话草稿"><div class="demo-agent-choices" role="group" aria-label="Agent">${agentOrder.map(index => { const agent = agents[index]; return `<button type="button" class="demo-agent-choice agent-${agent.id}" data-demo-action="draft-agent" data-index="${index}" aria-label="${index === 2 ? "DeepSeek" : agent.name}" aria-pressed="${state.draftAgent === index}">${mark(agent)}</button>`; }).join("")}${state.draftAgent === 1 ? `<span class="demo-codex-anchor"><button type="button" class="demo-draft-agent-name demo-codex-trigger" data-demo-action="codex-menu" aria-label="选择 Codex 版本" aria-haspopup="menu" aria-expanded="${!!state.codexMenu}">${codexName(state.codexVariant)}${icon("chevron-down")}</button>${state.codexMenu ? codexMenu() : ""}</span>` : `<strong class="demo-draft-agent-name">${draftName}</strong>`}${button("draft-more", "选择更多 Agent", "more", 'aria-haspopup="dialog"')}</div><button type="button" class="demo-directory-label" data-demo-action="draft-directory" aria-label="工作目录" id="demo-draft-directory">${icon("folder")}<span>${esc(state.directory)}</span>${icon("chevron-down")}</button><div class="demo-draft-compose"><label class="demo-draft-input"><textarea id="demo-first-message" aria-label="第一句话" placeholder="让 ${draftName} 做什么？">${esc(state.text)}</textarea></label>${button("draft-send", action.label, action.icon)}</div></section>`;
  }
  function agentSheet() {
    const choices = draftSources.map(({ kind, index, variant }) => {
      const agent = agents[index], selected = index === state.draftAgent && (!variant || variant === state.codexVariant);
      return `<button type="button" class="demo-agent-option" data-demo-action="draft-source" data-kind="${kind}" aria-pressed="${selected}">${mark(agent)}<span>${variant ? codexName(variant) : agent.name}</span></button>`;
    }).join("");
    return `<div class="demo-modal-scrim" data-demo-action="draft-more-close"></div><section class="demo-protocol-sheet demo-agent-sheet" role="dialog" aria-modal="true" aria-labelledby="demo-agent-title"><h2 id="demo-agent-title">选择 Agent</h2><div class="demo-agent-grid">${choices}</div><button type="button" class="demo-sheet-cancel" data-demo-action="draft-more-close">取消</button></section>`;
  }
  function closeAgentSheet() {
    state.agentSheet = false; render(); $("[data-demo-action=draft-more]")?.focus();
  }
  function codexMenu() {
    return `<div class="demo-codex-menu" role="menu" aria-label="Codex 版本">${["terminal", "desktop"].map(variant => `<button type="button" role="menuitemradio" aria-checked="${state.codexVariant === variant}" data-demo-action="codex-variant" data-value="${variant}"><span>${codexName(variant)}</span>${state.codexVariant === variant ? icon("check") : ""}</button>`).join("")}</div>`;
  }
  function tabs(active) {
    return `<nav class="demo-tabs" aria-label="主导航">${[["home", "聊天", "chat"], ["providers", "Agent", "tune"], ["settings", "设置", "gear"]].map(([id, label, name]) => `<button type="button" data-demo-action="tab" data-page="${id}" aria-current="${active === id ? "page" : "false"}">${icon(active === id ? name + "-fill" : name)}<span>${label}</span></button>`).join("")}</nav>`;
  }
  function drawer() {
    const groups = ["/Projects/orbis", "/Projects/website"];
    return `<div class="demo-drawer-scrim" data-demo-action="drawer-close"></div><aside class="demo-drawer" aria-label="会话目录"><header><strong>会话目录</strong>${button("drawer-close", "关闭会话目录", "close")}</header><label class="demo-search">${icon("search")}<input id="demo-directory-search" value="${esc(state.search)}" placeholder="搜索会话或目录" aria-label="搜索会话或目录"></label><div class="demo-tree">${groups.map(directory => `<section class="demo-tree-group"><button type="button" class="demo-tree-heading" data-demo-action="directory-toggle" data-directory="${directory}" aria-expanded="${state.expanded.has(directory)}">${icon("folder")}<span>${directory.split("/").pop()}</span><small>${sessions.filter(session => session.directory === directory).length}</small>${icon("chevron-right")}</button>${state.expanded.has(directory) ? `<div class="demo-tree-branches">${sessions.filter(session => session.directory === directory && `${session.title} ${directory}`.toLowerCase().includes(state.search.toLowerCase())).map(session => `<button type="button" class="demo-tree-session" data-demo-action="session-open" data-id="${session.id}">${mark(agents[session.agent])}<span>${esc(session.title)}</span></button>`).join("")}<button type="button" class="demo-tree-new" data-demo-action="directory-new" data-directory="${directory}">${icon("plus")}新建会话</button></div>` : ""}</section>`).join("")}</div></aside>`;
  }
  function layoutDial() {
    const dial = $(".demo-dial"); if (!dial) return;
    const width = dial.clientWidth || 393, height = dial.clientHeight || 340;
    const g = policy.dialGeometry(width, height);
    const ring = (element, radius) => Object.assign(element.style, { left: `${g.cx - radius}px`, top: `${g.cy - radius}px`, width: `${radius * 2}px`, height: `${radius * 2}px` });
    ring($(".demo-dial-disc"), g.radius);
    ring($(".demo-dial-moat"), g.seam);
    ring($(".demo-dial-hub"), g.hub);
    ring($(".demo-dial-hollow"), g.hole);
    dial.classList.toggle("is-cropped", g.radius > g.height / 2 - 20);
    const channel = $(".demo-dial-channel");
    if (channel) Object.assign(channel.style, { left: `${g.pinChannelLeft}px`, top: `${g.cy - 22}px`, width: `${g.pinChannelWidth}px` });
    const agentPos = state.dragAgent ?? state.dialIndex;
    const agent = currentDialAgent();
    const list = currentProfiles(agent);
    const profilePos = state.dragProfile ?? currentProfileIndex(agent);

    let socketLit = 0;
    for (const el of root.querySelectorAll(".demo-dial-agent")) {
      const idx = Number(el.dataset.index);
      const item = dialAgents[idx];
      const distance = idx - agentPos;
      const travel = idx === state.dialIndex ? (state.pinDrag ?? (item.enabled ? 1 : 0)) : (item.enabled ? 1 : 0);
      if (item.enabled) socketLit += policy.dialSeated(distance) * travel;
      const centre = policy.dialPinCentre(g, distance, travel);
      const gate = policy.dialGate(distance);
      el.hidden = Math.abs(distance) >= 3.1 || centre.x < -12 || centre.y < 18 || centre.y > g.height - 18;
      Object.assign(el.style, { left: `${centre.x - 24}px`, top: `${centre.y - 24}px`, opacity: String(0.42 + 0.58 * gate) });
      const cap = el.querySelector(".demo-dial-cap");
      if (cap) cap.style.opacity = String(gate);
    }
    dial.dataset.seated = String(socketLit > 0.65);

    for (const el of root.querySelectorAll(".demo-dial-profile")) {
      const delta = Number(el.dataset.index) - profilePos;
      const a = delta * g.step * Math.PI / 180;
      const x = g.cx + (g.radius + 28) * Math.cos(a);
      Object.assign(el.style, {
        left: `${x}px`, top: `${g.cy + (g.radius + 28) * Math.sin(a)}px`,
        maxWidth: `${Math.max(80, g.width - x - 12)}px`,
        opacity: String(1 - 0.4 * Math.min(2, Math.abs(delta))),
        transform: `translateY(-50%) scale(${1 - 0.18 * Math.min(1, Math.abs(delta))})`,
      });
      el.hidden = Math.abs(delta * g.step) > 56;
    }
    const plate = $(".demo-dial-plate");
    if (plate) {
      const x = g.cx + g.radius + 28;
      Object.assign(plate.style, { left: `${x}px`, top: `${g.cy}px`, maxWidth: `${Math.max(92, g.width - x - 12)}px` });
    }
    Object.assign($(".demo-dial-pointer").style, { left: `${g.rim + 8}px`, top: `${g.cy - 4}px` });
    let ticks = "";
    for (let k = 0; k < Math.round(360 / (g.step / 8)); k++) {
      const a = (k * g.step / 8 - profilePos * g.step) * Math.PI / 180;
      const major = k % 8 === 0, mid = k % 4 === 0;
      const r0 = g.radius - (major ? 18 : mid ? 13 : 10), r1 = g.radius - 6;
      ticks += `<path class="${major ? "is-major" : ""}" d="M ${(g.cx + r0 * Math.cos(a)).toFixed(1)} ${(g.cy + r0 * Math.sin(a)).toFixed(1)} L ${(g.cx + r1 * Math.cos(a)).toFixed(1)} ${(g.cy + r1 * Math.sin(a)).toFixed(1)}"/>`;
    }
    for (let k = 0; k < 48; k++) {
      const a = k * 7.5 * Math.PI / 180, r = g.hub - 7;
      ticks += `<circle cx="${(g.cx + r * Math.cos(a)).toFixed(1)}" cy="${(g.cy + r * Math.sin(a)).toFixed(1)}" r="1.2"/>`;
    }
    for (let index = 0; index < list.length; index++) {
      const a = (index - profilePos) * g.step * Math.PI / 180, r = g.radius - 32;
      const current = isProfileActive(agent, index);
      ticks += `<circle class="demo-profile-dot ${current ? "is-current" : ""}" cx="${(g.cx + r * Math.cos(a)).toFixed(1)}" cy="${(g.cy + r * Math.sin(a)).toFixed(1)}" r="${current ? 3.4 : 2.8}"/>`;
    }
    const sweepR = g.radius - 12;
    const sweepC = (2 * Math.PI * sweepR).toFixed(1);
    dial.style.setProperty("--sweep-c", `${sweepC}px`);
    dial.style.setProperty("--sweep-arc", `${(sweepR * 1.92).toFixed(1)}px`);
    ticks += `<circle class="demo-dial-sweep" cx="${g.cx}" cy="${g.cy}" r="${sweepR}"/>`;
    ticks += `<circle class="demo-dial-sweep is-mir" cx="${g.cx}" cy="${g.cy}" r="${sweepR}" transform="matrix(1 0 0 -1 0 ${(2 * g.cy).toFixed(1)})"/>`;
    const svgEl = $(".demo-dial-ticks");
    svgEl.setAttribute("viewBox", `0 0 ${g.width} ${g.height}`);
    svgEl.innerHTML = ticks;
  }
  function variantBadge(variant) {
    if (!variant) return "";
    const glyph = variant === "terminal" ? "terminal" : variant === "desktop" ? "desktop-mini" : "web-mini";
    return `<span class="demo-dial-var" aria-hidden="true">${icon(glyph)}</span>`;
  }
  function agentStatusDot(item) {
    if (!item.enabled) return "";
    const kind = item.tone === "success" ? "success" : "hollow";
    return `<span class="demo-dial-sdot is-${kind}" aria-hidden="true"></span>`;
  }
  function providers() {
    const agent = currentDialAgent();
    const list = currentProfiles(agent);
    const pIndex = currentProfileIndex(agent);
    const profile = list[pIndex];
    const active = profile ? isProfileActive(agent, pIndex) : false;
    const enabledCount = dialAgents.filter(item => item.enabled).length;
    const power = agent.enabled ? "on" : "off";
    const showHint = Boolean(state.dialHint);
    const primary = (() => {
      if (!agent.enabled) return { disabled: state.moving, icon: "power", label: `启用 ${agent.label}` };
      if (!list.length) return { disabled: true, icon: "check", label: "已启用" };
      if (profile.readOnly) return { disabled: true, icon: "check", label: `正在使用 ${profile.name}` };
      const act = policy.profileAction(agent.group === "pi" ? 0 : 1, active, state.moving);
      return { disabled: act.disabled, icon: active && agent.group !== "pi" ? "check" : "swap", label: `${act.label}${profile.name}` };
    })();
    const facts = (() => {
      if (!agent.enabled) return `<p class="demo-quota-empty"></p>`;
      if (profile && active && profile.subscription) {
        return `<div class="demo-quota">${quotaWindow("5 小时", profile.fiveHour, profile.fiveReset)}${quotaWindow("7 天", profile.sevenDay, profile.sevenReset)}${button("quota-refresh", "刷新配额", "refresh")}</div>`;
      }
      if (agent.sessions.length > 0 && (!profile || !profile.subscription)) {
        return `<div class="demo-running-card">${agent.sessions.slice(0, 2).map(title => `<div class="demo-running-row"><i class="demo-dot"></i><span>${esc(title)}</span></div>`).join("")}<small>${agent.sessions.length} 个运行中</small></div>`;
      }
      if (list.length > 0) {
        return `<p class="demo-quota-empty">${profile?.subscription ? "启用后可查询配额" : "这个配置不提供配额查询"}</p>`;
      }
      return `<p class="demo-quota-empty"></p>`;
    })();

    return `<header class="demo-topbar"><h2>Agent</h2>${button("dial-refresh", "刷新 Agent 状态", "refresh")}</header>` +
      `<div class="demo-provider-flow">` +
      `<div class="demo-provider-host">${icon("desktop")}<strong>workstation</strong><small class="demo-enabled-count">${enabledCount} / ${dialAgents.length} 已启用</small></div>` +
      `<div class="demo-dial ${state.dialFx}" role="group" aria-label="Agent 配置转盘" data-agent="${agent.brand}" data-power="${power}" data-armed="${state.pinArmed}">` +
        `<div class="demo-dial-disc"></div><div class="demo-dial-moat"></div>` +
        `<div class="demo-dial-hub" role="slider" tabindex="0" data-dial-layer="agent" aria-label="Agent" aria-valuemin="0" aria-valuemax="${dialAgents.length - 1}" aria-valuenow="${state.dialIndex}" aria-valuetext="${agent.label}，${agent.enabled ? agent.status : "未启用"}"></div>` +
        `<div class="demo-dial-hollow"></div>` +
        `<svg class="demo-dial-ticks" aria-hidden="true"></svg>` +
        `<div class="demo-dial-channel" aria-hidden="true"><span class="demo-dial-socket"></span></div>` +
        `<div class="demo-dial-agents">${dialAgents.map((item, idx) => `<button type="button" class="demo-dial-agent ${item.enabled ? "is-on" : "is-off"}" data-demo-action="dial-agent" data-index="${idx}" data-kind="${item.kind}" tabindex="-1" aria-label="${item.label}，${item.enabled ? item.status : "未启用"}" aria-pressed="${idx === state.dialIndex}"><span class="demo-dial-cap"></span>${mark(item)}${agentStatusDot(item)}${variantBadge(item.variant)}</button>`).join("")}</div>` +
        `${list.length > 0 ? `<div class="demo-dial-labels" role="slider" tabindex="0" data-dial-layer="profile" aria-label="${agent.label} 的配置" aria-valuemin="0" aria-valuemax="${list.length - 1}" aria-valuenow="${pIndex}" aria-valuetext="${profile.name}">${list.map((item, index) => `<button type="button" class="demo-dial-profile" data-demo-action="dial-profile" data-index="${index}" tabindex="-1" aria-pressed="${index === pIndex}">${index === pIndex ? `<small class="demo-dial-kicker">${esc(agent.label)}</small>` : ""}<strong>${esc(item.name)}</strong>${index === pIndex ? `<small>${showHint ? `<span class="demo-dial-hint">${esc(state.dialHint)}</span>` : `${item.official ? "官方配置" : "已保存的配置"}`}</small>${!showHint && agent.sessions.length ? `<small class="demo-dial-running">${agent.sessions.length} 个运行中</small>` : ""}${isProfileActive(agent, index) ? `<span class="demo-dial-current">${icon("check")}${agent.group === "pi" ? "已启用" : "使用中"}</span>` : ""}` : ""}</button>`).join("")}</div>` : `<div class="demo-dial-plate"><small class="demo-dial-kicker">${esc(agent.label)}</small><strong class="demo-dial-state ${showHint ? "is-hint" : agent.enabled ? `is-${agent.tone}` : "is-off"}">${esc(showHint ? state.dialHint : (agent.enabled ? agent.status : "未启用"))}</strong>${!showHint && agent.enabled && agent.sessions.length ? `<small class="demo-dial-running">${agent.sessions.length} 个运行中</small>` : ""}</div>`}` +
        `<span class="demo-dial-pointer agent-${agent.brand}"></span>` +
      `</div>` +
      `<div class="demo-dial-facts">${facts}</div>` +
      `<button type="button" class="demo-primary demo-apply" data-demo-action="provider-apply" ${primary.disabled ? "disabled" : ""}>${icon(primary.icon)}<span>${esc(primary.label)}</span></button>` +
      `<div class="demo-dial-footer"><span class="demo-dial-tip" role="status">${esc(state.dialHint)}</span>${list.length ? `<span class="demo-dial-position" aria-label="配置位置">${pIndex + 1} / ${list.length}</span>` : ""}</div>` +
      `</div>${tabs("providers")}`;
  }
  function quotaWindow(label, remaining, reset) {
    return `<section class="demo-quota-window${remaining <= 20 ? " danger" : ""}"><div>${label}${remaining <= 20 ? `<span>${icon("warning")}即将用完</span>` : ""}</div><strong>${remaining}<small>%</small></strong><div class="demo-progress"><i data-remaining="${remaining}"></i></div><small>${reset}</small></section>`;
  }
  function preview(theme) {
    const card = live => `<span class="demo-preview-card"><i class="demo-preview-dot ${live ? "is-live" : ""}"></i><span><i></i><i></i></span></span>`;
    return `<span class="demo-theme-preview" data-ob="${theme}" aria-hidden="true"><i class="demo-preview-bar"></i>${card(true)}${card(false)}<span class="demo-preview-field"><i></i></span></span>`;
  }
  function settings() {
    const pref = currentAppearance(), theme = dark => `${pref.material === "sage" ? "sage-" : ""}${dark ? "dark" : "light"}`;
    return `<header class="demo-topbar"><h2>设置</h2></header><div class="demo-settings"><section><h3>连接</h3><div class="demo-setting-group"><div class="demo-setting-host"><span class="demo-connection-leading">${icon("desktop")}</span><span><strong>workstation</strong><small>局域网，${state.protocol === "ws" ? "WebSocket" : "QUIC"}，12 ms</small></span><span class="demo-connected"><i class="demo-dot"></i>已连接</span></div><button type="button" data-demo-action="protocol"><strong>连接协议</strong><span class="demo-protocol-value">${protocolName(state.protocol)}${icon("chevron-right")}</span></button></div></section><section><h3>外观</h3><div class="demo-appearance"><div class="demo-appearance-tiles" role="radiogroup" aria-label="浅色与深色">${[false, true].map(dark => `<button type="button" class="demo-appearance-tile" role="radio" aria-checked="${pref.mode !== "system" && pref.dark === dark}" data-demo-action="appearance-mode" data-value="${dark ? "dark" : "light"}"><span class="demo-preview-frame">${preview(theme(dark))}</span><span class="demo-appearance-name"><i class="demo-radio"></i>${dark ? "深色" : "浅色"}</span></button>`).join("")}</div><button type="button" class="demo-follow-row" data-demo-action="appearance-follow" role="radio" aria-checked="${pref.mode === "system"}">${icon("gear")}<span>跟随系统</span>${pref.mode === "system" ? icon("check") : ""}</button><div class="demo-material-row"><span>材质</span><div role="radiogroup" aria-label="材质">${[["mist", "雾蓝"], ["sage", "灰绿"]].map(([id, name]) => `<button type="button" class="demo-material" role="radio" aria-checked="${pref.material === id}" data-demo-action="appearance-material" data-value="${id}"><span class="demo-material-frame"><i data-ob="${id === "sage" ? "sage-" : ""}${pref.dark ? "dark" : "light"}"></i></span>${name}</button>`).join("")}</div></div></div></section><section><h3>语言</h3><div class="demo-setting-group"><button type="button" data-demo-action="language"><span><strong>${state.language === "system" ? "跟随手机" : state.language === "en" ? "English" : "简体中文"}</strong><small>${state.language === "en" ? "English" : "简体中文"}</small></span>${icon("chevron-right")}</button></div></section></div>${tabs("settings")}`;
  }
  function languageSheet() {
    return choiceSheet("语言", "language", state.draftLanguage, [{ id: "system", title: "跟随手机" }, { id: "zh-Hans", title: "简体中文" }, { id: "en", title: "English" }], state.draftLanguage === state.language ? "正在使用" : "应用语言", state.draftLanguage === state.language);
  }
  function directorySheet() {
    return `<div class="demo-modal-scrim" data-demo-action="directory-cancel"></div><section class="demo-protocol-sheet" role="dialog" aria-modal="true" aria-label="工作目录"><h2>工作目录</h2>${["/Projects/orbis", "/Projects/website"].map(directory => `<button type="button" class="demo-directory-choice" data-demo-action="directory-pick" data-directory="${directory}" aria-current="${state.directory === directory}"><span>${icon("folder")}</span><strong>${directory.split("/").pop()}<small>${directory}</small></strong>${icon("chevron-right")}</button>`).join("")}<button type="button" class="demo-sheet-cancel" data-demo-action="directory-cancel">取消</button></section>`;
  }
  function choiceSheet(title, key, value, options, label, disabled) {
    return `<div class="demo-modal-scrim" data-demo-action="${key}-cancel"></div><section class="demo-protocol-sheet" role="dialog" aria-modal="true" aria-label="${title}"><h2>${title}</h2><div role="radiogroup" aria-label="${title}">${options.map(option => `<button type="button" class="demo-protocol-choice" role="radio" aria-checked="${value === option.id}" data-demo-action="${key}-choice" data-value="${option.id}"><i></i><span><strong>${option.title}</strong>${option.sub ? `<small>${option.sub}</small>` : ""}</span>${option.tag ? `<small>${option.tag}</small>` : ""}</button>`).join("")}</div><button type="button" class="demo-primary" data-demo-action="${key}-apply" ${disabled ? "disabled" : ""}>${label}</button><button type="button" class="demo-sheet-cancel" data-demo-action="${key}-cancel">取消</button></section>`;
  }
  function downloads() {
    return `<header class="demo-topbar">${button("back-home", "返回聊天列表", "arrow-left")}<h2>下载</h2></header><p class="demo-empty">暂无下载</p>`;
  }
  function protocolSheet() {
    const options = [{ id: "auto", title: "自动", tag: "推荐" }, { id: "quic", title: "QUIC", info: true }, { id: "ws", title: "WebSocket" }];
    return `<div class="demo-modal-scrim" data-demo-action="protocol-cancel"></div><section class="demo-protocol-sheet" role="dialog" aria-modal="true" aria-labelledby="demo-protocol-title"><h2 id="demo-protocol-title">连接协议</h2><div role="radiogroup" aria-label="连接协议">${options.map(option => `<div class="demo-protocol-option"><button type="button" class="demo-protocol-choice" role="radio" aria-checked="${state.draftProtocol === option.id}" data-demo-action="protocol-choice" data-value="${option.id}"><i></i><span><strong>${option.title}</strong></span>${option.tag ? `<small>${option.tag}</small>` : ""}</button>${option.info ? `<button type="button" class="demo-info" aria-label="查看 QUIC 说明" data-demo-action="protocol-info"><span aria-hidden="true">i</span></button>` : ""}</div>`).join("")}</div><button type="button" class="demo-primary" data-demo-action="protocol-apply" ${state.draftProtocol === state.protocol ? "disabled" : ""}>${state.draftProtocol === state.protocol ? "当前使用" : "切换到 " + protocolName(state.draftProtocol) + " 并重连"}</button><button type="button" class="demo-sheet-cancel" data-demo-action="protocol-cancel">取消</button></section>`;
  }
  function protocolInfo() {
    return `<div class="demo-info-scrim" data-demo-action="protocol-info-close"></div><section class="demo-dialog demo-info-dialog" role="dialog" aria-modal="true" aria-labelledby="demo-quic-title"><h2 id="demo-quic-title">QUIC</h2><p>当前网络不支持 QUIC 时无法连接</p><div><button type="button" class="demo-text-button primary" data-demo-action="protocol-info-close">知道了</button></div></section>`;
  }
  function chat() {
    const session = sessions.find(item => item.id === state.session) || sessions[0];
    const agent = agents[session.agent];
    return `<header class="demo-topbar">${button("back-home", "返回聊天列表", "arrow-left")}<h2>${esc(session.title)}</h2>${button("downloads", "下载", "download")}</header><div class="demo-chat">${session.firstMessage === "" ? "" : `<div class="demo-message-user">${esc(session.firstMessage || "首页下拉回弹有点卡，帮我看看")}</div><div class="demo-message-assistant"><strong class="agent-${agent.id}">${mark(agent)}${sessionAgentName(session)}</strong><p>收到。我会先查看相关实现，再逐项修改和验证。</p></div>`}</div><div class="demo-chat-composer"><input aria-label="消息" placeholder="发给 ${sessionAgentName(session)}，/ 命令">${button("chat-send", "发送", "arrow-up")}</div>`;
  }
  function confirmation() {
    const agent = currentDialAgent();
    const list = currentProfiles(agent);
    const pIndex = currentProfileIndex(agent);
    const profile = list[pIndex] || { name: "本机配置" };
    const isPi = agent.group === "pi";
    const enabled = isPi && state.piEnabled.has(pIndex);
    return `<div class="demo-modal-scrim"></div><section class="demo-dialog" role="dialog" aria-modal="true" aria-labelledby="demo-confirm-title"><h2 id="demo-confirm-title">${isPi ? (enabled ? "从 Pi 移出 " : "为 Pi 启用 ") : "切换 " + agent.title + " 到 "}${esc(profile.name)}？</h2><p>${isPi ? "Pi 配置将在当前电脑上启用或移出。" : "已有会话需要重新打开。"}</p><div><button type="button" class="demo-text-button" data-demo-action="provider-cancel">取消</button><button type="button" class="demo-text-button primary" data-demo-action="provider-confirm">${isPi ? (enabled ? "移出 Pi 配置" : "启用 Pi 配置") : "切换并重载 Agent"}</button></div></section>`;
  }
  function disableConfirmation() {
    const agent = dialAgents[state.disableTarget ?? state.dialIndex];
    return `<div class="demo-modal-scrim" data-demo-action="disable-cancel"></div><section class="demo-dialog" role="dialog" aria-modal="true" aria-labelledby="demo-disable-title"><h2 id="demo-disable-title">停用 ${esc(agent.label)}？</h2><p>Orbis 将断开此 Agent 的接入，不会退出原生应用。</p>${agent.sessions.length ? `<div class="demo-disable-sessions">${agent.sessions.map(item => `<div class="demo-running-row"><i class="demo-dot"></i><span>${esc(item)}</span></div>`).join("")}</div>` : ""}<div><button type="button" class="demo-text-button" data-demo-action="disable-cancel">取消</button><button type="button" class="demo-text-button danger" data-demo-action="disable-confirm">停用</button></div></section>`;
  }
  function notice(text, undoKind = null) { state.notice = text; state.undoKind = undoKind; render(); }
  function flashDialFx(cls, ms = 760) {
    window.clearTimeout?.(fxTimer);
    state.dialFx = reduced() ? "" : cls;
    render();
    if (!reduced() && window.setTimeout) fxTimer = window.setTimeout(() => { state.dialFx = ""; if (!disposed) $(".demo-dial")?.classList.remove("is-powering", "is-dimming"); }, ms);
  }
  function showDialHint(text, ms = 1400) {
    window.clearTimeout?.(hintTimer);
    state.dialHint = text;
    render();
    if (text && ms > 0 && window.setTimeout) hintTimer = window.setTimeout(() => { state.dialHint = ""; if (!disposed && state.page === "providers") render(); }, ms);
  }
  function animatePinTo(from, to, done) {
    window.cancelAnimationFrame?.(pinAnimation);
    const ms = duration(220);
    if (!ms || !window.requestAnimationFrame) { delete state.pinDrag; done?.(); return; }
    state.pinDrag = from;
    const start = window.performance.now();
    const step = now => {
      if (disposed) return;
      const t = Math.min(1, (now - start) / ms);
      state.pinDrag = from + (to - from) * (1 - Math.pow(1 - t, 3));
      layoutDial();
      if (t < 1) pinAnimation = window.requestAnimationFrame(step);
      else { delete state.pinDrag; done?.(); }
    };
    pinAnimation = window.requestAnimationFrame(step);
  }
  function commitAgentEnabled(index, target, skipConfirm = false) {
    const agent = dialAgents[index];
    if (!agent || agent.enabled === target) return;
    if (!target && !skipConfirm && agent.sessions.length > 0) {
      state.dialog = "disable"; state.disableTarget = index; render(); $(".demo-dialog button")?.focus(); return;
    }
    const from = state.pinDrag ?? (agent.enabled ? 1 : 0);
    agent.enabled = target;
    agent.status = target ? (agent.sessions.length || agent.group === "codex" || agent.group === "claude" || agent.group === "agy" ? "已连接" : "可启动") : "未启用";
    agent.tone = target && agent.status === "已连接" ? "success" : "neutral";
    state.dialog = null; state.disableTarget = null; state.dialHint = ""; state.pinArmed = false;
    animatePinTo(from, target ? 1 : 0, () => {
      if (target) {
        state.notice = ""; state.undoKind = null;
        flashDialFx("is-powering", 800);
      } else {
        flashDialFx("is-dimming", 560);
        notice(`已停用 ${agent.label}`, agent.kind);
      }
    });
  }
  function nudgePin() {
    const agent = currentDialAgent();
    showDialHint(agent.enabled ? "向内拉停用" : "向外推启用", 1500);
    if (!reduced() && window.requestAnimationFrame) {
      const rest = agent.enabled ? 1 : 0;
      const peak = agent.enabled ? 0.78 : 0.22;
      animatePinTo(rest, peak, () => animatePinTo(peak, rest, () => layoutDial()));
    }
  }
  function toggleSelection(id) { if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); render(); }
  async function openDraft(directory = state.directory) {
    state.directory = directory; state.codexMenu = null; state.drawer = false; state.draft = true; state.page = "home"; render();
    const draftEl = $(".demo-draft"), height = draftEl.offsetHeight;
    const material = window.getComputedStyle(root), inset = material.getPropertyValue("--inset-md"), raised = material.getPropertyValue("--raised-md");
    void motion(draftEl, [{ boxShadow: inset }, { boxShadow: inset, offset: 0.45 }, { boxShadow: raised }], 460);
    for (const content of draftEl.children) void motion(content, [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 0, offset: 0.3 }, { opacity: 1, transform: "none" }], 280);
    await motion(draftEl, [{ height: "0px" }, { height: `${height}px` }], 260, "cubic-bezier(.4,0,.2,1)");
    $("#demo-first-message")?.focus({ preventScroll: true });
  }
  async function closeDraft() {
    const draftEl = $(".demo-draft");
    if (draftEl) await motion(draftEl, [{ height: `${draftEl.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }], 260, "cubic-bezier(.4,0,.2,1)");
    state.draft = false; state.codexMenu = null; render();
  }
  async function sendDraft() {
    if (state.moving || !state.draft) return;
    const firstMessage = state.text.trim(), draftEl = $(".demo-draft"); state.moving = true;
    const rect = draftEl.getBoundingClientRect(), screenRect = root.getBoundingClientRect(), scale = screenRect.width / 393;
    const cover = draftEl.cloneNode(true); cover.classList.add("demo-draft-morph"); root.append(cover);
    await motion(cover, [{ left: `${(rect.left - screenRect.left) / scale}px`, top: `${(rect.top - screenRect.top) / scale}px`, width: `${rect.width / scale}px`, height: `${rect.height / scale}px`, borderRadius: "24px" }, { left: "0px", top: "0px", width: "393px", height: "852px", borderRadius: "0px" }], 320, "cubic-bezier(.32,.72,0,1)");
    if (disposed) return;
    const session = { id: nextId++, title: firstMessage || state.directory.split("/").filter(Boolean).pop() || "新会话", directory: state.directory, agent: state.draftAgent, codexVariant: state.draftAgent === 1 ? state.codexVariant : undefined, firstMessage };
    sessions.unshift(session); state.session = session.id; state.page = "chat"; state.draft = false; state.text = ""; state.moving = false; render();
    if (firstMessage) void motion($(".demo-message-user"), [{ opacity: 0, transform: "translateY(24px)" }, { opacity: 1, transform: "none" }], 440);
  }
  function selectDialAgent(index) {
    const next = Math.max(0, Math.min(dialAgents.length - 1, index));
    const old = state.dialIndex;
    state.dialIndex = next;
    state.dialHint = ""; state.pinArmed = false;
    const agent = currentDialAgent();
    if (agent.group && state.profileByGroup[agent.group] === undefined) state.profileByGroup[agent.group] = state.activeByGroup[agent.group] ?? 0;
    else if (agent.group && old !== next) state.profileByGroup[agent.group] = state.activeByGroup[agent.group] ?? 0;
    render();
    if (old !== next && !state.moving) void motion($(".demo-dial-labels") || $(".demo-dial-plate"), [{ opacity: 0 }, { opacity: 1 }], 160);
  }
  function selectProfile(index) {
    const agent = currentDialAgent();
    const list = currentProfiles(agent);
    if (!agent.group || !list.length) return;
    const old = currentProfileIndex(agent);
    const next = Math.max(0, Math.min(list.length - 1, index));
    state.profileByGroup[agent.group] = next;
    render();
    if (old !== next && !state.moving) void motion($(".demo-dial-labels"), [{ transform: `translateY(${(next - old) * 48}px)` }, { transform: "none" }], 220);
  }
  function settleDial(layer, target) {
    window.cancelAnimationFrame?.(dialAnimation);
    const agent = currentDialAgent();
    const count = layer === "agent" ? dialAgents.length : Math.max(1, currentProfiles(agent).length);
    const end = Math.max(0, Math.min(count - 1, target));
    const key = layer === "agent" ? "dragAgent" : "dragProfile";
    const from = state[key] ?? (layer === "agent" ? state.dialIndex : currentProfileIndex(agent));
    state.moving = true; state[key] = from;
    if (layer === "agent") selectDialAgent(end); else selectProfile(end);
    const ms = duration(220 + Math.min(240, Math.abs(end - from) * 75));
    if (!ms || !window.requestAnimationFrame) { delete state[key]; state.moving = false; render(); return; }
    const start = window.performance.now();
    const frame = now => {
      if (disposed) return;
      const t = Math.min(1, (now - start) / ms);
      state[key] = from + (end - from) * (1 - Math.pow(1 - t, 3));
      layoutDial();
      if (t < 1) dialAnimation = window.requestAnimationFrame(frame);
      else { delete state[key]; state.moving = false; render(); }
    };
    dialAnimation = window.requestAnimationFrame(frame);
  }
  function handleAction(action, target) {
    if (action === "draft-toggle") { if (state.draft) void closeDraft(); else void openDraft(); return; }
    if (action === "codex-menu") { state.codexMenu = true; render(); $('.demo-codex-menu [aria-checked="true"]')?.focus(); return; }
    if (action === "codex-menu-close") { state.codexMenu = null; render(); $(".demo-codex-trigger")?.focus(); return; }
    if (action === "codex-variant") { state.codexVariant = target.dataset.value; state.codexMenu = null; render(); $(".demo-codex-trigger")?.focus(); return; }
    if (action === "draft-directory") { state.directorySheet = true; render(); return; }
    if (action === "directory-pick") { state.directory = target.dataset.directory; state.directorySheet = false; render(); return; }
    if (action === "directory-cancel") { state.directorySheet = false; render(); return; }
    if (action === "appearance-mode") { appearance?.update({ mode: target.dataset.value }); render(); return; }
    if (action === "appearance-material") { appearance?.update({ material: target.dataset.value }); render(); return; }
    if (action === "appearance-follow") { appearance?.update({ mode: "system" }); render(); return; }
    if (action === "language") { state.draftLanguage = state.language; state.languageSheet = true; render(); return; }
    if (action === "language-choice") { state.draftLanguage = target.dataset.value; render(); return; }
    if (action === "language-cancel") { state.languageSheet = false; render(); return; }
    if (action === "language-apply") { state.language = state.draftLanguage; state.languageSheet = false; render(); return; }
    if (action === "draft-agent") { state.draftAgent = Number(target.dataset.index); state.codexMenu = null; render(); return; }
    if (action === "draft-more") { state.agentSheet = true; state.codexMenu = null; render(); $(".demo-agent-option[aria-pressed=true]")?.focus(); return; }
    if (action === "draft-more-close") { closeAgentSheet(); return; }
    if (action === "draft-source") {
      const source = draftSources.find(item => item.kind === target.dataset.kind);
      if (source) { state.draftAgent = source.index; if (source.variant) state.codexVariant = source.variant; closeAgentSheet(); }
      return;
    }
    if (action === "draft-send") { void sendDraft(); return; }
    if (action === "drawer-open") { state.drawer = true; render(); void motion($(".demo-drawer"), [{ transform: "translateX(-320px)" }, { transform: "none" }], 320); return; }
    if (action === "drawer-close") { void motion($(".demo-drawer"), [{ transform: "none" }, { transform: "translateX(-320px)" }], 180).then(() => { state.drawer = false; render(); }); return; }
    if (action === "directory-toggle") { const dir = target.dataset.directory; if (state.expanded.has(dir)) state.expanded.delete(dir); else state.expanded.add(dir); render(); return; }
    if (action === "directory-new") { void openDraft(target.dataset.directory); return; }
    if (action === "select-session") { toggleSelection(Number(target.dataset.id)); return; }
    if (action === "selection-cancel") { state.selected.clear(); render(); return; }
    if (action === "close-selected") { sessions = sessions.filter(session => !state.selected.has(session.id)); state.selected.clear(); render(); return; }
    if (action === "session-open") { state.session = Number(target.dataset.id); state.drawer = false; state.page = "chat"; render(); return; }
    if (action === "tab") {
      const page = target.dataset.page; if (page === state.page) return;
      void motion($(".demo-content"), [{ opacity: 1 }, { opacity: 0 }], 90, "cubic-bezier(.4,0,1,1)").then(() => {
        state.page = page; state.drawer = false; render();
        void motion($(".demo-content"), [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], 210);
      });
      return;
    }
    if (action === "back-home") { state.page = "home"; render(); return; }
    if (action === "dial-agent") {
      const idx = Number(target.dataset.index);
      if (idx === state.dialIndex) nudgePin(); else settleDial("agent", idx);
      return;
    }
    if (action === "dial-profile") { settleDial("profile", Number(target.dataset.index)); return; }
    if (action === "dial-refresh") { notice("已按电脑同步"); return; }
    if (action === "provider-apply" && !state.moving) {
      const agent = currentDialAgent();
      if (!agent.enabled) { commitAgentEnabled(state.dialIndex, true); return; }
      state.dialog = "provider"; render(); $(".demo-dialog button")?.focus(); return;
    }
    if (action === "provider-cancel") { state.dialog = null; render(); $(".demo-apply")?.focus(); return; }
    if (action === "provider-confirm") {
      const agent = currentDialAgent();
      const list = currentProfiles(agent);
      const pIndex = currentProfileIndex(agent);
      const profile = list[pIndex];
      if (!profile) { state.dialog = null; render(); return; }
      if (agent.group === "pi") {
        const active = state.piEnabled.has(pIndex);
        if (active) state.piEnabled.delete(pIndex); else state.piEnabled.add(pIndex);
        state.dialog = null; notice(`${active ? "已移出" : "已启用"} Pi 配置 ${profile.name}`);
      } else {
        state.activeByGroup[agent.group] = pIndex;
        state.dialog = null; notice(`已切换 ${agent.title} 到 ${profile.name}`);
      }
      return;
    }
    if (action === "disable-cancel") { state.dialog = null; state.disableTarget = null; render(); return; }
    if (action === "disable-confirm") {
      const idx = state.disableTarget ?? state.dialIndex;
      commitAgentEnabled(idx, false, true);
      return;
    }
    if (action === "agent-undo") {
      const idx = dialAgents.findIndex(item => item.kind === state.undoKind);
      state.notice = ""; state.undoKind = null;
      if (idx >= 0) { state.dialIndex = idx; commitAgentEnabled(idx, true); } else render();
      return;
    }
    if (action === "quota-refresh") { notice("配额已更新"); return; }
    if (action === "notice-close") { state.notice = ""; state.undoKind = null; render(); return; }
    if (action === "downloads") { state.page = "downloads"; render(); return; }
    if (action === "protocol") { state.draftProtocol = state.protocol; state.protocolSheet = true; render(); return; }
    if (action === "protocol-choice") { state.draftProtocol = target.dataset.value; render(); return; }
    if (action === "protocol-info") { state.protocolInfo = true; render(); $(".demo-info-dialog button")?.focus(); return; }
    if (action === "protocol-info-close") { state.protocolInfo = false; render(); $(".demo-info")?.focus(); return; }
    if (action === "protocol-cancel") { state.protocolInfo = false; state.protocolSheet = false; render(); return; }
    if (action === "protocol-apply") { state.protocol = state.draftProtocol; state.protocolSheet = false; notice("已应用连接协议，演示连接已恢复"); return; }
    if (action === "chat-send") { const input = $(".demo-chat-composer input"); if (input.value.trim()) { notice("已发送"); } }
  }
  root.addEventListener("click", event => {
    if (suppressClick) { suppressClick = false; return; }
    const target = event.target.closest("[data-demo-action]");
    if (target) { if (target.disabled) return; handleAction(target.dataset.demoAction, target); return; }
    const card = event.target.closest("[data-session]");
    if (card) { const id = Number(card.dataset.session); if (state.selected.size) toggleSelection(id); else { state.session = id; state.page = "chat"; render(); } }
  });
  root.addEventListener("input", event => {
    if (event.target.id === "demo-first-message") {
      state.text = event.target.value;
      const action = policy.draftAction(state.text), control = $("[data-demo-action=draft-send]");
      control.setAttribute("aria-label", action.label); control.innerHTML = icon(action.icon);
    }
    if (event.target.id === "demo-directory-search") {
      state.search = event.target.value; const position = event.target.selectionStart; render();
      const input = $("#demo-directory-search"); input.focus(); input.setSelectionRange(position, position);
    }
  });
  root.addEventListener("change", event => { if (event.target.id === "demo-draft-directory") state.directory = event.target.value; });
  root.addEventListener("keydown", event => {
    if (state.agentSheet && event.key === "Tab") {
      const items = [...root.querySelectorAll(".demo-agent-sheet button")], first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.key === "Escape") {
      if (state.agentSheet) closeAgentSheet();
      else if (state.protocolInfo) handleAction("protocol-info-close", event.target);
      else if (state.codexMenu) handleAction("codex-menu-close", event.target);
      else if (state.languageSheet) { state.languageSheet = false; render(); }
      else if (state.directorySheet) { state.directorySheet = false; render(); }
      else if (state.protocolSheet) { state.protocolSheet = false; render(); }
      else if (state.dialog) { state.dialog = null; state.disableTarget = null; render(); }
      else if (state.drawer) handleAction("drawer-close", event.target);
      else if (state.draft) void closeDraft();
      else { state.page = "home"; render(); }
      return;
    }
    if (state.codexMenu && ["ArrowUp", "ArrowDown", "Home", "End", "Tab"].includes(event.key)) {
      const options = [...root.querySelectorAll(".demo-codex-menu button")];
      if (event.key === "Tab") { event.preventDefault(); handleAction("codex-menu-close", event.target); return; }
      const index = options.indexOf(document.activeElement); event.preventDefault();
      options[event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length]?.focus();
      return;
    }
    if (state.protocolInfo && event.key === "Tab") { event.preventDefault(); $(".demo-info-dialog button")?.focus(); return; }
    if (state.dialog && event.key === "Tab") {
      const buttons = [...root.querySelectorAll(".demo-dialog button")];
      const index = buttons.indexOf(document.activeElement); event.preventDefault();
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
      return;
    }
    const slider = event.target.closest("[data-dial-layer]");
    if (slider) {
      const isAgent = slider.dataset.dialLayer === "agent";
      if (isAgent && (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === " ")) {
        event.preventDefault();
        const target = event.key === " " ? !currentDialAgent().enabled : event.key === "ArrowRight";
        commitAgentEnabled(state.dialIndex, target);
        root.querySelector('[data-dial-layer="agent"]')?.focus();
        return;
      }
      if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const list = currentProfiles(currentDialAgent());
        const count = isAgent ? dialAgents.length : Math.max(1, list.length);
        const current = isAgent ? state.dialIndex : currentProfileIndex(currentDialAgent());
        const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : current + (event.key === "ArrowDown" ? 1 : -1);
        settleDial(isAgent ? "agent" : "profile", Math.max(0, Math.min(count - 1, next)));
        root.querySelector(`[data-dial-layer=${isAgent ? "agent" : "profile"}]`)?.focus();
        return;
      }
    }
    if (event.key === "Enter" && event.target.id === "demo-first-message" && !event.shiftKey) { event.preventDefault(); void sendDraft(); return; }
    const card = event.target.closest("[data-session]");
    if (card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); if (event.shiftKey || state.selected.size) toggleSelection(Number(card.dataset.session)); else card.click(); }
  });
  root.addEventListener("pointerdown", event => {
    suppressClick = false;
    if (event.button !== 0 || event.target.closest("input,textarea,select")) return;
    const card = event.target.closest("[data-session]"), dial = event.target.closest(".demo-dial");
    if (!card && !dial) return;
    if (event.target.closest("button") && !dial) return;
    const bounds = root.getBoundingClientRect(), scale = bounds.width / 393;
    const localX = (event.clientX - bounds.left) / scale;
    if (dial && event.pointerType === "touch" && localX < 20) return;
    const dialBounds = dial?.getBoundingClientRect(), dialY = dial ? (event.clientY - dialBounds.top) / scale : 0;
    const g = dial ? policy.dialGeometry(dial.clientWidth || 393, dial.clientHeight || 340) : null;
    const inChannel = dial ? policy.dialInPinChannel(localX, dialY, g) : false;
    const layer = dial ? policy.dialLayer(localX, dialY, event.pointerType === "touch", g) : null;
    if (dial && !layer && !inChannel) return;
    const agent = currentDialAgent();
    const knobX = g ? g.pinStart + g.pinTravel * (agent.enabled ? 1 : 0) : 0;
    const onKnob = inChannel && g && Math.hypot(localX - knobX, dialY - g.cy) <= 26;
    if (dial) { window.cancelAnimationFrame?.(dialAnimation); window.cancelAnimationFrame?.(pinAnimation); delete state.dragAgent; delete state.dragProfile; delete state.pinDrag; }
    gesture = {
      lastY: event.clientY, lastTime: window.performance.now(), velocity: 0,
      target: card || dial, card, dial, g, inChannel, onKnob,
      layer: onKnob ? "pin" : (layer || (inChannel ? "agent" : null)),
      mode: onKnob ? "pin" : null,
      startEnabled: agent.enabled,
      start: layer === "profile" ? currentProfileIndex(agent) : state.dialIndex,
      feedbackSent: false, armed: false,
      x: event.clientX, y: event.clientY, scale, id: event.pointerId, moved: false,
    };
    if (card) selectionHold = window.setTimeout(() => { if (gesture && !gesture.moved) { toggleSelection(Number(card.dataset.session)); gesture = undefined; suppressClick = true; } }, 450);
  });
  root.addEventListener("pointermove", event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = (event.clientX - gesture.x) / gesture.scale, dy = (event.clientY - gesture.y) / gesture.scale;
    if (Math.hypot(dx, dy) > 8) window.clearTimeout(selectionHold);
    if (gesture.card) {
      if (!gesture.moved && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { gesture = undefined; return; }
      if (Math.abs(dx) < 8 && !gesture.moved) return;
      gesture.moved = true; root.setPointerCapture(event.pointerId);
      gesture.target.style.transform = `translateX(${Math.min(0, dx)}px)`;
      const feedback = gesture.target.previousElementSibling, progress = Math.min(1, -dx / (gesture.target.offsetWidth * 0.4));
      feedback.dataset.armed = String(progress >= 1);
      feedback.querySelector(".demo-swipe-label").textContent = policy.swipeArmed(-dx, gesture.target.offsetWidth) ? "松手关闭" : "关闭";
      feedback.querySelector("circle").style.strokeDashoffset = String(100 * (1 - progress));
      if (progress >= 1 && !gesture.feedbackSent) {
        gesture.feedbackSent = true;
        if (!reduced()) void motion(feedback.querySelector(".demo-swipe-seat"), [{ transform: "scale(1)" }, { transform: "scale(1.12)", offset: 0.5 }, { transform: "scale(1)" }], 260);
        if (!reduced() && event.isTrusted) { try { window.navigator.vibrate?.(12); } catch { /* Optional browser feedback never blocks the gesture. */ } }
      }
      event.preventDefault();
      return;
    }
    const agent = currentDialAgent();
    if (!gesture.mode) {
      const dist = Math.hypot(dx, dy);
      if (gesture.inChannel && dist >= 8 && policy.dialPinHorizontal(dx, dy)) {
        gesture.mode = "pin";
      } else {
        const threshold = gesture.layer === "agent" ? 10 : 4;
        if (Math.abs(dy) < threshold) return;
        if (gesture.layer === "profile" && currentProfiles(agent).length === 0) return;
        gesture.mode = gesture.layer;
      }
    }
    if (!gesture.moved) {
      if (gesture.mode === "pin" && Math.hypot(dx, dy) < 4) return;
      gesture.moved = true;
      if (gesture.mode !== "pin") { gesture.y = event.clientY; gesture.lastY = event.clientY; gesture.lastTime = window.performance.now(); }
      root.setPointerCapture(event.pointerId);
      state.moving = true;
    }
    if (gesture.mode === "pin") {
      const travel = policy.dialPinDrag(gesture.startEnabled, dx, gesture.g.pinTravel);
      state.pinDrag = travel;
      const armed = policy.dialPinArmed(gesture.startEnabled, travel) && Math.abs(dy) <= 72;
      if (armed !== gesture.armed) {
        gesture.armed = armed;
        state.pinArmed = armed;
        const hint = armed ? policy.dialPinReleaseHint(gesture.startEnabled, agent.sessions.length) : "";
        state.dialHint = hint;
        const dialEl = $(".demo-dial"); if (dialEl) dialEl.dataset.armed = String(armed);
        const tipEl = $(".demo-dial-tip"); if (tipEl) tipEl.textContent = hint;
      }
      layoutDial();
      const applyBtn = $(".demo-apply"); if (applyBtn) applyBtn.disabled = true;
      event.preventDefault();
      return;
    }
    const list = currentProfiles(agent);
    const count = gesture.mode === "agent" ? dialAgents.length : Math.max(1, list.length);
    const distance = (event.clientY - gesture.y) / gesture.scale;
    const position = gesture.start - distance / (gesture.mode === "agent" ? 84 : 96);
    const clamped = Math.max(0, Math.min(count - 1, position));
    const now = window.performance.now();
    const velocity = -(event.clientY - gesture.lastY) / gesture.scale / 96 / Math.max(1, now - gesture.lastTime);
    gesture.velocity = 0.7 * gesture.velocity + 0.3 * velocity; gesture.lastTime = now; gesture.lastY = event.clientY;
    if (gesture.mode === "agent") {
      const rounded = Math.round(clamped), d = clamped - rounded;
      state.dragAgent = rounded + Math.sign(d) * 0.5 * Math.pow(Math.abs(d) * 2, 2.4);
      selectDialAgent(rounded);
    } else {
      state.dragProfile = clamped;
      selectProfile(Math.round(clamped));
    }
    layoutDial();
    const dialEl = $(".demo-dial"); if (dialEl) dialEl.dataset.grab = gesture.mode;
    const applyBtn = $(".demo-apply"); if (applyBtn) applyBtn.disabled = true;
    event.preventDefault();
  }, { passive: false });
  function finish(event) {
    window.clearTimeout(selectionHold); if (!gesture || event.pointerId !== gesture.id) return;
    const old = gesture; gesture = undefined;
    if (old.moved) {
      suppressClick = true;
      if (old.card) {
        const dx = (event.clientX - old.x) / old.scale;
        if (event.type !== "pointercancel" && policy.swipeArmed(-dx, old.target.offsetWidth)) {
          const id = Number(old.card.dataset.session);
          void motion(old.target, [{ transform: old.target.style.transform }, { transform: "translateX(-430px)", opacity: 0 }], 160).then(() => { sessions = sessions.filter(session => session.id !== id); render(); });
        } else void motion(old.target, [{ transform: old.target.style.transform }, { transform: "none" }], 320).then(render);
      } else if (old.mode === "pin") {
        state.moving = false; state.pinArmed = false; state.dialHint = "";
        const dy = (event.clientY - old.y) / old.scale;
        if (event.type !== "pointercancel" && old.armed && Math.abs(dy) <= 72) {
          commitAgentEnabled(state.dialIndex, !old.startEnabled);
        } else {
          animatePinTo(state.pinDrag ?? (old.startEnabled ? 1 : 0), old.startEnabled ? 1 : 0, () => render());
        }
      } else {
        const agent = currentDialAgent();
        const count = old.mode === "agent" ? dialAgents.length : Math.max(1, currentProfiles(agent).length);
        const position = state[old.mode === "agent" ? "dragAgent" : "dragProfile"] ?? old.start;
        const target = event.type === "pointercancel" ? old.start : policy.dialRelease(old.mode, position, window.performance.now() - old.lastTime > 80 ? 0 : old.velocity, count);
        settleDial(old.mode, target);
      }
    }
  }
  root.addEventListener("pointerup", finish); root.addEventListener("pointercancel", finish);
  const unsubscribe = appearance?.subscribe(() => { if (state.page === "settings") render(); });
  screen.append(root); render();
  return {
    togglePlayback() {
      if (playing) { stopPlayback(); return; }
      stopPlayback();
      if (scene === "agent") {
        // Choreographed tour of the latest dual-ring switching dial + enablement pin.
        dialAgents[10].enabled = false; dialAgents[10].status = "未启用"; dialAgents[10].tone = "neutral";
        state.dialIndex = 0; state.profileByGroup.codex = 0; state.activeByGroup.codex = 0;
        state.dialog = null; state.notice = ""; state.undoKind = null; state.dialHint = ""; state.page = "providers";
        render();
        if (reduced()) {
          state.activeByGroup.codex = 1; state.profileByGroup.codex = 1;
          dialAgents[10].enabled = true; dialAgents[10].status = "已连接"; dialAgents[10].tone = "success";
          state.dialIndex = 10; render(); return;
        }
        playing = true; onPlayback(true);
        const steps = [
          [550, () => settleDial("profile", 1)],
          [1450, () => { state.dialog = "provider"; render(); }],
          [2350, () => { state.activeByGroup.codex = 1; state.dialog = null; notice("已切换 Codex 到 relay-b"); }],
          [3400, () => { state.notice = ""; settleDial("agent", 2); }],
          [4750, () => settleDial("agent", 10)],
          [5950, () => { state.dialHint = "松手启用"; state.pinArmed = true; animatePinTo(0, 0.72, () => commitAgentEnabled(10, true)); }],
          [7300, () => { playing = false; onPlayback(false); }],
        ];
        playback = steps.map(([at, fn]) => window.setTimeout(() => { if (!disposed) void fn(); }, at));
        return;
      }
      if (scene === "create") {
        state.page = "home"; state.draft = false; state.text = ""; state.draftAgent = 1; state.codexVariant = "desktop"; render();
        if (reduced()) {
          state.draft = true; state.text = "检查并修复首页回弹，补齐测试"; render(); void sendDraft(); return;
        }
        playing = true; onPlayback(true);
        const sample = "检查并修复首页回弹，补齐测试";
        const steps = [
          [450, () => openDraft()],
          [1100, () => { state.codexMenu = true; render(); }],
          [1700, () => { state.codexVariant = "desktop"; state.codexMenu = null; render(); }],
          ...[...sample].map((_, i) => [2050 + i * 70, () => { state.text = sample.slice(0, i + 1); render(); }]),
          [3450, () => sendDraft()],
          [4200, () => { playing = false; onPlayback(false); }],
        ];
        playback = steps.map(([at, fn]) => window.setTimeout(() => { if (!disposed) void fn(); }, at));
        return;
      }
      // sessions scene playback: open drawer, highlight directory tree, close drawer, show multi-select batch mode.
      state.page = "home"; state.drawer = false; state.selected.clear(); render();
      if (reduced()) { state.selected.add(2); render(); return; }
      playing = true; onPlayback(true);
      const steps = [
        [450, () => handleAction("drawer-open")],
        [1450, () => { state.expanded.add("/Projects/website"); render(); }],
        [2300, () => handleAction("drawer-close")],
        [3050, () => { state.selected.add(2); render(); }],
        [3850, () => { state.selected.add(3); render(); }],
        [4650, () => { state.selected.clear(); render(); playing = false; onPlayback(false); }],
      ];
      playback = steps.map(([at, fn]) => window.setTimeout(() => { if (!disposed) void fn(); }, at));
    },
    pause: stopPlayback,
    destroy() {
      disposed = true; window.cancelAnimationFrame?.(dialAnimation); window.cancelAnimationFrame?.(pinAnimation);
      window.clearTimeout(hintTimer); window.clearTimeout(fxTimer);
      unsubscribe?.(); stopPlayback(); window.clearTimeout(selectionHold); root.remove();
    },
  };
};

/* Multi-format in-chat file preview demo: HTML, image, Markdown and video (ChatFilePreview). */
window.createOrbisPreviewDemo = function ({ screen, reduced, onPlayback, onPage }) {
  const root = document.createElement("div");
  root.className = "design-demo preview-demo";
  root.id = "design-demo";
  const chrome = [...screen.querySelectorAll("#s4-home > .ui-time,#s4-home > .ui-sys")].map(el => el.outerHTML).join("");
  const icon = name => `<i class="ico i-${name}" aria-hidden="true"></i>`;
  const svg = (path, size = 18) => `<svg class="demo-svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const fmtIcon = kind => ({
    html: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a13 13 0 0 1 0 18"/><path d="M12 3a13 13 0 0 0 0 18"/>', 18),
    image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 16-5-5-6 6-2-2-5 5"/>', 18),
    markdown: icon("doc"),
    video: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><polygon points="10 9 16 12 10 15" fill="currentColor" stroke="none"/>', 18),
  })[kind];
  const files = [
    { id: "html", name: "launch-report.html", size: "184 KB", badge: "HTML", tone: "html" },
    { id: "image", name: "hero-banner.png", size: "1.6 MB", badge: "图片", tone: "image" },
    { id: "markdown", name: "release-notes.md", size: "12 KB", badge: "Markdown", tone: "markdown" },
    { id: "video", name: "refresh-demo.mp4", size: "4.2 MB", badge: "视频", tone: "video" },
  ];
  const htmlMetrics = {
    all: {
      label: "全部", fcp: "142 ms", pass: "99.8%", protoLabel: "传输保护", proto: "AEAD",
      path: "M4 46 L38 39 L72 42 L106 28 L140 23 L174 26 L208 13 L242 9",
      area: "M4 46 L38 39 L72 42 L106 28 L140 23 L174 26 L208 13 L242 9 L242 60 L4 60 Z",
      d1: [208, 13], d2: [242, 9],
      note: "双端 128 项回归全部通过",
      checks: [["离线 WebView 沙箱", "通过"], ["分片 SHA-256 校验", "通过"], ["全屏手势与缩放", "通过"]],
    },
    ios: {
      label: "iOS", fcp: "118 ms", pass: "100%", protoLabel: "交互帧率", proto: "60 fps",
      path: "M4 42 L38 34 L72 32 L106 22 L140 19 L174 15 L208 10 L242 7",
      area: "M4 42 L38 34 L72 32 L106 22 L140 19 L174 15 L208 10 L242 7 L242 60 L4 60 Z",
      d1: [208, 10], d2: [242, 7],
      note: "弹簧回弹与离线 WebView 渲染正常",
      checks: [["WKContentRuleList 离线策略", "通过"], ["弹簧回弹帧率 60 fps", "通过"], ["深浅色与灰绿材质", "通过"]],
    },
    android: {
      label: "Android", fcp: "154 ms", pass: "99.6%", protoLabel: "传输协议", proto: "QUIC",
      path: "M4 48 L38 44 L72 39 L106 33 L140 26 L174 22 L208 16 L242 11",
      area: "M4 48 L38 44 L72 39 L106 33 L140 26 L174 22 L208 16 L242 11 L242 60 L4 60 Z",
      d1: [208, 16], d2: [242, 11],
      note: "分片校验与沙箱预览均已通过",
      checks: [["离线请求拦截与零外联", "通过"], ["QUIC 多流历史同步", "通过"], ["原位预览与原件下载", "通过"]],
    },
  };
  const markdownDoc = `<article class="file-demo-document" aria-label="Markdown 正文"><h3>移动端回归清单</h3><p>本次版本覆盖对话同步、文件预览与加密传输。</p><h4>验证项目</h4><ul><li><strong>HTML 预览：</strong>离线沙箱渲染与全屏交互</li><li><strong>图片与视频：</strong>支持 4× 缩放与全屏播放</li><li><strong>Markdown：</strong>原生排版与代码块阅读</li></ul><blockquote>所有预览文件均按需分片拉取并完成 SHA-256 校验。</blockquote><pre><code>npm run check</code></pre></article>`;

  let page = "chat";
  let expanded = "html";
  let htmlFilter = "all";
  let imageZoom = 1;
  let videoPlaying = false;
  let videoSec = 6;
  const videoDuration = 18;
  const saved = new Set();
  let noticeText = "";
  let timers = [], videoRaf = 0, videoLast = 0, playing = false, disposed = false;

  const formatTime = sec => `0:${String(Math.floor(sec)).padStart(2, "0")}`;
  const stopVideoLoop = () => { window.cancelAnimationFrame?.(videoRaf); videoRaf = 0; videoLast = 0; };
  function startVideoLoop() {
    stopVideoLoop();
    if (!videoPlaying || reduced() || !window.requestAnimationFrame) return;
    const step = now => {
      if (disposed || !videoPlaying || page !== "reader" || expanded !== "video") { stopVideoLoop(); return; }
      if (videoLast) {
        videoSec = (videoSec + Math.min(80, now - videoLast) / 1000) % videoDuration;
        const fill = root.querySelector(".preview-video-fill");
        const clock = root.querySelector(".preview-video-clock");
        if (fill) fill.style.width = `${(videoSec / videoDuration * 100).toFixed(1)}%`;
        if (clock) clock.textContent = formatTime(videoSec);
      }
      videoLast = now;
      videoRaf = window.requestAnimationFrame(step);
    };
    videoRaf = window.requestAnimationFrame(step);
  }
  function stop() {
    timers.forEach(t => window.clearTimeout(t)); timers = [];
    if (playing) { playing = false; onPlayback(false); }
  }
  function htmlPreview(full) {
    const m = htmlMetrics[htmlFilter];
    return `<div class="preview-web ${full ? "is-full" : ""}">
      <div class="preview-web-head"><span class="preview-web-badge">Orbis v0.1.25</span><em>离线安全渲染</em></div>
      ${full ? `<div class="preview-web-tabs" role="tablist" aria-label="平台筛选">${Object.entries(htmlMetrics).map(([key, item]) => `<button type="button" role="tab" aria-selected="${htmlFilter === key}" data-preview-action="html-filter" data-value="${key}">${item.label}</button>`).join("")}</div>` : ""}
      <div class="preview-web-kpis">
        <div><small>首屏渲染</small><b>${m.fcp}</b></div>
        <div><small>回归通过</small><b class="is-ok">${m.pass}</b></div>
        <div><small>${m.protoLabel}</small><b class="is-accent">${m.proto}</b></div>
      </div>
      <svg class="preview-web-chart" viewBox="0 0 248 60" aria-hidden="true">
        <path class="preview-chart-area" d="${m.area}"/>
        <path class="preview-chart-line" d="${m.path}"/>
        <circle class="preview-chart-dot" cx="${m.d1[0]}" cy="${m.d1[1]}" r="3.4"/>
        <circle class="preview-chart-dot is-ok" cx="${m.d2[0]}" cy="${m.d2[1]}" r="3.4"/>
      </svg>
      ${full ? `<p class="preview-web-note">${m.note}</p><div class="preview-web-checks">${m.checks.map(([name, status]) => `<div><span>${name}</span><b>${status}</b></div>`).join("")}</div>` : ""}
    </div>`;
  }
  function imagePreview(full) {
    return `<div class="preview-image-stage ${full ? "is-full" : ""}" data-zoom="${full ? imageZoom : 1}">
      <div class="preview-image-art" ${full ? 'data-preview-action="image-zoom-cycle" role="button" tabindex="0" aria-label="切换图片缩放倍率"' : ""}>
        <div class="preview-art-orbit"></div>
        <div class="preview-art-orbit is-inner"></div>
        <img src="assets/promo/orbis-symbol-2048.png" width="76" height="76" alt="Orbis 渲染预览图">
        <span class="preview-art-caption">Orbis 4× 缩放查看</span>
      </div>
      ${full ? `<div class="preview-zoom-bar" role="group" aria-label="缩放倍率">${[1, 2, 4].map(level => `<button type="button" data-preview-action="image-zoom" data-value="${level}" aria-pressed="${imageZoom === level}">${level}×</button>`).join("")}</div>` : ""}
    </div>`;
  }
  function videoPreview(full) {
    const pct = (videoSec / videoDuration * 100).toFixed(1);
    return `<div class="preview-video-stage ${full ? "is-full" : ""} ${videoPlaying && full ? "is-playing" : ""}">
      <div class="preview-video-viewport" aria-hidden="true">
        <div class="preview-vid-phone">
          <div class="preview-vid-bar"></div>
          <div class="preview-vid-spring"><i></i></div>
          <div class="preview-vid-card"></div>
          <div class="preview-vid-card is-short"></div>
        </div>
        <span class="preview-vid-tag">弹簧回弹 60 fps</span>
      </div>
      ${full ? `<div class="preview-video-controls">
        <button type="button" class="preview-video-play" data-preview-action="video-toggle" aria-label="${videoPlaying ? "暂停视频" : "播放视频"}">${videoPlaying ? "Ⅱ" : "▶"}</button>
        <span class="preview-video-clock">${formatTime(videoSec)}</span>
        <button type="button" class="preview-video-track" data-preview-action="video-scrub" aria-label="调整播放进度"><span class="preview-video-fill" data-progress="${pct}"></span></button>
        <span class="preview-video-total">0:18</span>
      </div>` : `<div class="preview-video-poster-overlay"><span class="preview-play-badge">▶</span><span class="preview-video-dur">0:18</span></div>`}
    </div>`;
  }
  function inlineBody(id) {
    if (id === "html") return htmlPreview(false);
    if (id === "image") return imagePreview(false);
    if (id === "markdown") return `<div class="preview-md-inline">${markdownDoc}</div>`;
    return videoPreview(false);
  }
  function readerBody(id) {
    if (id === "html") return htmlPreview(true);
    if (id === "image") return imagePreview(true);
    if (id === "markdown") return markdownDoc;
    return videoPreview(true);
  }
  function chatView() {
    return `<header class="demo-topbar"><span class="preview-chat-brand"><span class="demo-agentmark demo-mark-codex" aria-hidden="true"></span><span><strong>发布页与动效产物</strong><small><i class="demo-dot idle"></i>空闲</small></span></span><span class="preview-dl-pill" aria-label="已下载数量">${icon("download")}<b>${saved.size}</b></span></header>
      <div class="preview-scroll">
        <div class="demo-message-user"><p>导出这一版的报告页、预览图、说明文档和录屏，发我直接看。</p></div>
        <div class="demo-message-assistant">
          <strong class="agent-codex"><span class="demo-agentmark demo-mark-codex" aria-hidden="true"></span>Codex</strong>
          <p>产物已准备好，点击卡片即可在对话内直接预览：</p>
          <div class="preview-cards">${files.map(file => {
            const open = expanded === file.id;
            const isSaved = saved.has(file.id);
            return `<div class="preview-card-group" data-format="${file.id}">
              <div class="preview-card-row">
                <button type="button" class="preview-file-btn" data-preview-action="toggle" data-file="${file.id}" aria-expanded="${open}" aria-label="${open ? "收起" : "预览"} ${file.name}">
                  <span class="preview-fmt-ico is-${file.tone}">${fmtIcon(file.id)}</span>
                  <span class="preview-file-name">${file.name}</span>
                  <span class="preview-file-size">${file.size}</span>
                  ${icon("chevron-down")}
                </button>
                <button type="button" class="demo-icon preview-dl-btn ${isSaved ? "is-saved" : ""}" data-preview-action="save" data-file="${file.id}" aria-label="下载 ${file.name}">${icon(isSaved ? "check" : "download")}</button>
              </div>
              ${open ? `<div class="preview-panel" data-format="${file.id}">
                <div class="preview-panel-surface" data-preview-action="fullscreen" data-file="${file.id}" role="button" tabindex="0" aria-label="全屏预览 ${file.name}">
                  ${inlineBody(file.id)}
                  <span class="preview-expand-chip" aria-hidden="true">${icon("arrow-up-left")}</span>
                </div>
              </div>` : ""}
            </div>`;
          }).join("")}</div>
        </div>
      </div>
      <div class="preview-composer">
        <div class="preview-composer-meta">${icon("folder")}<code>/Projects/orbis</code><span>工作区写入</span></div>
        <div class="preview-composer-bar"><span>发给 Codex，/ 命令</span><span class="preview-send-stub">${icon("arrow-up")}</span></div>
      </div>`;
  }
  function readerView() {
    const file = files.find(item => item.id === expanded) || files[0];
    const isSaved = saved.has(file.id);
    return `<header class="demo-topbar"><button type="button" class="demo-icon" data-preview-action="close-reader" aria-label="返回对话">${icon("arrow-left")}</button><h2>${file.name}</h2><button type="button" class="demo-icon ${isSaved ? "is-saved" : ""}" data-preview-action="save" data-file="${file.id}" aria-label="下载 ${file.name}">${icon(isSaved ? "check" : "download")}</button></header>
      <div class="preview-reader-scroll" data-format="${file.id}">${readerBody(file.id)}</div>`;
  }
  function render() {
    if (disposed) return;
    root.dataset.page = page;
    root.dataset.format = expanded || "none";
    onPage?.(page);
    root.innerHTML = chrome +
      `<div class="demo-content">${page === "reader" ? readerView() : chatView()}</div>` +
      `${noticeText ? `<div class="demo-notice" role="status"><span>${noticeText}</span><button type="button" class="demo-icon" data-preview-action="notice-close" aria-label="关闭提示">${icon("close")}</button></div>` : ""}` +
      `<div class="film-home-indicator"></div>`;
    for (const el of root.querySelectorAll("[data-progress]")) el.style.width = `${el.dataset.progress}%`;
    if (page === "reader" && expanded === "video" && videoPlaying) startVideoLoop(); else stopVideoLoop();
  }
  function act(action, target, event) {
    if (action === "toggle") {
      const id = target.dataset.file;
      expanded = expanded === id ? "" : id;
      videoPlaying = false;
      render();
      root.querySelector(`[data-preview-action="toggle"][data-file="${id}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (action === "fullscreen") {
      const id = target.dataset.file;
      expanded = id; page = "reader";
      if (id === "video") videoPlaying = !reduced();
      render();
      root.querySelector('[data-preview-action="close-reader"]')?.focus({ preventScroll: true });
      return;
    }
    if (action === "close-reader") {
      page = "chat"; videoPlaying = false; render();
      root.querySelector(`[data-preview-action="toggle"][data-file="${expanded}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (action === "html-filter") { htmlFilter = target.dataset.value; render(); root.querySelector(`[data-preview-action="html-filter"][data-value="${htmlFilter}"]`)?.focus({ preventScroll: true }); return; }
    if (action === "image-zoom") { imageZoom = Number(target.dataset.value); render(); root.querySelector(`[data-preview-action="image-zoom"][data-value="${imageZoom}"]`)?.focus({ preventScroll: true }); return; }
    if (action === "image-zoom-cycle") { imageZoom = imageZoom === 1 ? 2 : imageZoom === 2 ? 4 : 1; render(); root.querySelector('[data-preview-action="image-zoom-cycle"]')?.focus({ preventScroll: true }); return; }
    if (action === "video-toggle") { videoPlaying = !videoPlaying; render(); root.querySelector('[data-preview-action="video-toggle"]')?.focus({ preventScroll: true }); return; }
    if (action === "video-scrub") {
      const rect = target.getBoundingClientRect();
      const ratio = rect.width ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0.5;
      videoSec = ratio * videoDuration;
      render(); root.querySelector('[data-preview-action="video-scrub"]')?.focus({ preventScroll: true }); return;
    }
    if (action === "save") {
      const id = target.dataset.file;
      const file = files.find(item => item.id === id);
      saved.add(id); noticeText = `已保存 ${file.name}`; render(); return;
    }
    if (action === "notice-close") { noticeText = ""; render(); }
  }
  root.addEventListener("click", event => {
    const target = event.target.closest("[data-preview-action]");
    if (target) { stop(); act(target.dataset.previewAction, target, event); }
  });
  root.addEventListener("keydown", event => {
    if (event.key === "Escape" && page === "reader") { stop(); act("close-reader"); return; }
    if ((event.key === "Enter" || event.key === " ") && event.target.matches('[role="button"][data-preview-action]')) {
      event.preventDefault(); stop(); act(event.target.dataset.previewAction, event.target, event);
    }
  });
  screen.append(root); render();
  return {
    togglePlayback() {
      if (playing) { stop(); return; }
      page = "chat"; expanded = ""; htmlFilter = "all"; imageZoom = 1; videoPlaying = false; videoSec = 4; noticeText = ""; render();
      const steps = [
        [450, () => { expanded = "html"; render(); }],
        [1350, () => { page = "reader"; render(); }],
        [2150, () => { htmlFilter = "ios"; render(); }],
        [3050, () => { page = "chat"; expanded = "image"; render(); }],
        [3950, () => { page = "reader"; imageZoom = 2; render(); }],
        [4900, () => { page = "chat"; expanded = "markdown"; render(); root.querySelector(".preview-scroll")?.scrollTo({ top: 180, behavior: reduced() ? "auto" : "smooth" }); }],
        [5950, () => { expanded = "video"; render(); root.querySelector(".preview-scroll")?.scrollTo({ top: 260, behavior: reduced() ? "auto" : "smooth" }); }],
        [6800, () => { page = "reader"; videoSec = 6; videoPlaying = !reduced(); render(); }],
        [8100, () => { videoSec = 11; videoPlaying = false; render(); stop(); }],
      ];
      if (reduced()) {
        page = "reader"; expanded = "video"; videoSec = 11; videoPlaying = false; render(); return;
      }
      playing = true; onPlayback(true);
      timers = steps.map(([at, fn]) => window.setTimeout(() => { if (!disposed) fn(); }, at));
    },
    pause() { stop(); videoPlaying = false; stopVideoLoop(); },
    destroy() { disposed = true; stop(); stopVideoLoop(); root.remove(); },
  };
};

/* Privacy & Security demo: QR key exchange (hostPub + psk -> X25519/HKDF -> AES-256-GCM E2EE). */
window.createOrbisPrivacyDemo = function ({ screen, reduced, onPlayback, onPage }) {
  const root = document.createElement("div");
  root.className = "design-demo privacy-demo";
  root.id = "design-demo";
  const chrome = [...screen.querySelectorAll("#s4-home > .ui-time,#s4-home > .ui-sys")].map(el => el.outerHTML).join("");
  const icon = name => `<i class="ico i-${name}" aria-hidden="true"></i>`;
  const svg = (path, size = 18) => `<svg class="demo-svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const shieldSvg = svg('<path d="M12 3 4.5 6.5v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6.5Z"/><path d="m9 12 2 2 4-4"/>', 28);
  const keySvg = svg('<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8"/><path d="m16 7 2 2"/><path d="m19 4 2 2"/>', 16);
  const phoneSvg = svg('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18h2"/>', 18);

  let stage = "entry"; // entry | scanning | secured
  let kexStep = 0; // 0: locking QR, 1: hostPub+psk, 2: X25519+HMAC, 3: AES-256-GCM ready
  let route = "lan"; // lan | relay
  let lens = "plain"; // plain | cipher
  let telemetry = false;
  let telemetryInfo = false;
  let timers = [], playing = false, disposed = false;

  const clearTimers = () => { timers.forEach(t => window.clearTimeout(t)); timers = []; };
  function stop() {
    clearTimers();
    if (playing) { playing = false; onPlayback(false); }
  }
  function runHandshake(afterSecured) {
    clearTimers();
    stage = "scanning"; kexStep = 0; render();
    if (reduced()) {
      kexStep = 3; stage = "secured"; render(); afterSecured?.(); return;
    }
    const seq = [
      [520, () => { kexStep = 1; render(); }],
      [1220, () => { kexStep = 2; render(); }],
      [1960, () => { kexStep = 3; render(); }],
      [2550, () => { stage = "secured"; render(); afterSecured?.(); }],
    ];
    timers = seq.map(([at, fn]) => window.setTimeout(() => { if (!disposed) fn(); }, at));
  }
  function entryView() {
    return `<header class="demo-topbar"><h2>隐私安全</h2><span class="privacy-top-badge">${icon("lock")}端到端加密</span></header>
      <div class="privacy-entry">
        <div class="privacy-logo-well"><img src="assets/promo/orbis-mark-ios.png" width="48" height="48" alt=""></div>
        <h3>扫码交换密钥</h3>
        <div class="privacy-chain" aria-label="物理路径交换密钥">
          <div class="privacy-chain-node">${icon("desktop")}<span>电脑 QR</span></div>
          <span class="privacy-chain-arrow" aria-hidden="true">→</span>
          <div class="privacy-chain-node">${icon("qrscan")}<span>手机镜头</span></div>
          <span class="privacy-chain-arrow" aria-hidden="true">→</span>
          <div class="privacy-chain-node is-accent">${keySvg}<span>X25519</span></div>
        </div>
        <div class="privacy-key-pills">
          <span>Host 公钥</span>
          <span>一次性配对密钥</span>
          <span>中继不接触密钥</span>
        </div>
        <button type="button" class="demo-primary privacy-scan-btn" data-privacy-action="start-scan">${icon("qrscan")}<span>扫码交换密钥</span></button>
        <button type="button" class="demo-sheet-cancel privacy-peek-btn" data-privacy-action="open-secured">查看已加密连接</button>
        <p class="privacy-demo-note">演示二维码，不连接真实电脑</p>
      </div>`;
  }
  function scanningView() {
    const steps = [
      { id: 1, title: "读取二维码公钥与一次性密钥", code: "hostPub + psk" },
      { id: 2, title: "X25519 本地协商并双向认证", code: "HKDF-SHA256 / HMAC" },
      { id: 3, title: "派生会话密钥，建立端到端加密", code: "AES-256-GCM" },
    ];
    return `<header class="demo-topbar"><button type="button" class="demo-icon" data-privacy-action="reset" aria-label="返回">${icon("close")}</button><h2>扫码交换密钥</h2></header>
      <div class="privacy-scan-body">
        <div class="privacy-finder ${kexStep >= 1 ? "is-locked" : ""}">
          <div class="privacy-finder-screen">
            <div class="privacy-host-window">
              <div class="privacy-host-bar"><i></i><i></i><i></i><span>Orbis Host</span></div>
              <img class="privacy-qr-img" src="assets/promo/qr-orbising.svg" width="124" height="124" alt="演示配对二维码">
            </div>
            <div class="privacy-lock-frame" aria-hidden="true"><i class="is-tl"></i><i class="is-tr"></i><i class="is-bl"></i><i class="is-br"></i></div>
            <div class="privacy-scan-beam" aria-hidden="true"></div>
          </div>
          ${kexStep >= 1 ? `<div class="privacy-fp-pill">${keySvg}<code>hostPub 7F3A 9C4E</code></div>` : `<div class="privacy-fp-pill is-waiting">对准电脑端配对二维码</div>`}
        </div>
        <ol class="privacy-kex-list" aria-label="密钥交换步骤">
          ${steps.map(step => {
            const done = kexStep >= step.id;
            const active = kexStep === step.id - 1;
            return `<li class="${done ? "is-done" : active ? "is-active" : ""}">
              <span class="privacy-kex-dot">${done ? icon("check") : active ? '<i class="privacy-spin"></i>' : "<i></i>"}</span>
              <div><strong>${step.title}</strong><code>${step.code}</code></div>
            </li>`;
          }).join("")}
        </ol>
        <p class="privacy-demo-note">演示二维码，不连接真实电脑</p>
      </div>`;
  }
  function securedView() {
    const relay = route === "relay";
    return `<header class="demo-topbar"><h2>隐私安全</h2><span class="privacy-conn-chip"><i class="demo-dot"></i>${relay ? "加密中继" : "局域网"}${icon("lock")}</span></header>
      <div class="privacy-secured">
        <section class="privacy-hero-card">
          <div class="privacy-shield-orb">${shieldSvg}</div>
          <strong>端到端加密已建立</strong>
          <code>X25519 / HKDF-SHA256 / AES-256-GCM</code>
        </section>
        <section class="privacy-tunnel-card" aria-label="端到端加密隧道">
          <div class="privacy-tunnel-nodes">
            <div class="privacy-node"><span>${phoneSvg}</span><small>你的手机</small></div>
            <div class="privacy-tunnel-mid">
              <span class="privacy-lock-pill">${icon("lock")}AES-256-GCM</span>
              <div class="privacy-wire" aria-hidden="true"><i></i><i></i></div>
              <small>${relay ? "中继仅转发密文，不可读取" : "局域网端到端直连"}</small>
            </div>
            <div class="privacy-node"><span>${icon("desktop")}</span><small>workstation</small></div>
          </div>
          <div class="privacy-seg" role="group" aria-label="传输路径">
            <button type="button" data-privacy-action="route" data-value="lan" aria-pressed="${!relay}">局域网直连</button>
            <button type="button" data-privacy-action="route" data-value="relay" aria-pressed="${relay}">加密中继</button>
          </div>
          <div class="privacy-lens">
            <div class="privacy-lens-head">
              <button type="button" data-privacy-action="lens" data-value="plain" aria-pressed="${lens === "plain"}">本机明文</button>
              <button type="button" data-privacy-action="lens" data-value="cipher" aria-pressed="${lens === "cipher"}">中继视角</button>
            </div>
            <div class="privacy-lens-body ${lens === "cipher" ? "is-cipher" : ""}">
              ${lens === "plain" ? `<span>修首页下拉回弹，补齐测试</span>` : `<code>9f4c a812 e3b0 71d9 4b2a c60e 883f</code><small>仅路由头，不可读取</small>`}
            </div>
          </div>
        </section>
        <section class="privacy-meta-card">
          <div class="privacy-meta-row"><span>连接状态</span><b class="is-ok"><i class="demo-dot"></i>已加密</b></div>
          <div class="privacy-meta-row"><span>公钥指纹</span><code>7F3A 9C4E 2B18</code></div>
          <div class="privacy-meta-row"><span>连接延迟</span><b>${relay ? "28 ms" : "4 ms"}</b></div>
          <div class="privacy-meta-row">
            <span class="privacy-stat-label">设备使用统计<button type="button" class="demo-info privacy-info-btn" data-privacy-action="telemetry-info" aria-label="查看设备使用统计说明"><span aria-hidden="true">i</span></button></span>
            <button type="button" class="privacy-switch" role="switch" aria-checked="${telemetry}" aria-label="设备使用统计" data-privacy-action="telemetry-toggle"><i></i></button>
          </div>
        </section>
        <button type="button" class="demo-primary privacy-rescan-btn" data-privacy-action="start-scan">${icon("qrscan")}<span>重新扫码交换密钥</span></button>
      </div>
      ${telemetryInfo ? `<div class="demo-info-scrim" data-privacy-action="telemetry-info-close"></div><section class="demo-dialog demo-info-dialog" role="dialog" aria-modal="true" aria-labelledby="privacy-stat-title"><h2 id="privacy-stat-title">设备使用统计</h2><p>Relay 会汇总活跃设备数量，以了解有多少人在使用并规划服务器开支。开启后，Relay 还会统计此设备的收发流量、连接次数和时长。遥测不会收集聊天内容、文件内容或密码。</p><div><button type="button" class="demo-text-button primary" data-privacy-action="telemetry-info-close">知道了</button></div></section>` : ""}`;
  }
  function render() {
    if (disposed) return;
    root.dataset.page = stage;
    root.dataset.route = route;
    onPage?.(stage);
    root.innerHTML = chrome +
      `<div class="demo-content">${stage === "entry" ? entryView() : stage === "scanning" ? scanningView() : securedView()}</div>` +
      `<div class="film-home-indicator"></div>`;
  }
  function act(action, target) {
    if (action === "start-scan") { runHandshake(); return; }
    if (action === "open-secured") { clearTimers(); stage = "secured"; kexStep = 3; render(); return; }
    if (action === "reset") { clearTimers(); stage = "entry"; kexStep = 0; render(); return; }
    if (action === "route") { route = target.dataset.value; if (route === "relay") lens = "cipher"; render(); root.querySelector(`[data-privacy-action="route"][data-value="${route}"]`)?.focus({ preventScroll: true }); return; }
    if (action === "lens") { lens = target.dataset.value; render(); root.querySelector(`[data-privacy-action="lens"][data-value="${lens}"]`)?.focus({ preventScroll: true }); return; }
    if (action === "telemetry-toggle") { telemetry = !telemetry; render(); root.querySelector('[data-privacy-action="telemetry-toggle"]')?.focus({ preventScroll: true }); return; }
    if (action === "telemetry-info") { telemetryInfo = true; render(); root.querySelector(".demo-info-dialog button")?.focus(); return; }
    if (action === "telemetry-info-close") { telemetryInfo = false; render(); root.querySelector(".privacy-info-btn")?.focus(); }
  }
  root.addEventListener("click", event => {
    const target = event.target.closest("[data-privacy-action]");
    if (target) { stop(); act(target.dataset.privacyAction, target); }
  });
  root.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      if (telemetryInfo) { stop(); act("telemetry-info-close"); }
      else if (stage === "scanning") { stop(); act("reset"); }
    }
  });
  screen.append(root); render();
  return {
    togglePlayback() {
      if (playing) { stop(); return; }
      route = "lan"; lens = "plain"; telemetry = false; telemetryInfo = false;
      if (reduced()) {
        stage = "secured"; kexStep = 3; route = "relay"; lens = "cipher"; render(); return;
      }
      playing = true; onPlayback(true);
      stage = "entry"; kexStep = 0; render();
      timers = [window.setTimeout(() => {
        if (disposed) return;
        runHandshake(() => {
          timers = [
            window.setTimeout(() => { if (!disposed) { route = "relay"; lens = "cipher"; render(); } }, 950),
            window.setTimeout(() => { if (!disposed) { playing = false; onPlayback(false); } }, 2150),
          ];
        });
      }, 650)];
    },
    pause: stop,
    destroy() { disposed = true; stop(); root.remove(); },
  };
};
