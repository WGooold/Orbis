/* Web adaptation of ../video/claude/compositions/s3-agents.html and s4-features.html.
 * The film supplies the geometry, artwork, example conversations and motion language.
 * These are isolated demonstrations: no Agent or Host commands are sent. */
const motionPreference = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
const reducedMotion = () => motionPreference?.matches ?? false;
const byId = id => document.getElementById(id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const icon = name => `<i class="ico i-${name}" aria-hidden="true"></i>`;
const agentImage = (file, className = "") => `<img class="${className}" src="assets/promo/agents/${file}.svg" alt="" draggable="false">`;

function revealHeadline() {
  const title = byId("hero-title");
  title.setAttribute("aria-label", title.textContent);
  const walker = document.createTreeWalker(title, globalThis.NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let index = 0;
  for (const node of nodes) {
    const fragment = document.createDocumentFragment();
    for (const char of node.textContent) {
      const span = document.createElement("span");
      span.className = "headline-char";
      span.textContent = char;
      span.setAttribute("aria-hidden", "true");
      span.style.setProperty("--ink-delay", `${index++ * 38}ms`);
      fragment.append(span);
    }
    node.replaceWith(fragment);
  }
}

// One visibility-aware clock for both stages. No hidden-page or offscreen timers.
function createClock({ root, toggle, duration, frame, advance, labels }) {
  let elapsed = 0;
  let paused = reducedMotion();
  let visible = !("IntersectionObserver" in globalThis) || root.getBoundingClientRect().top < globalThis.innerHeight;
  let held = false;
  let previous;
  let request;
  let stopAt;
  const running = () => !paused && visible && !document.hidden && !held;
  function update() {
    root.dataset.playing = String(running());
    toggle.setAttribute("aria-label", paused ? labels.play : labels.pause);
    toggle.querySelector(".play-icon").textContent = paused ? "▶" : "Ⅱ";
    toggle.querySelector(".play-label").textContent = paused ? labels.shortPlay : labels.shortPause;
    root.classList.toggle("is-paused", !running());
    if (request !== undefined) globalThis.cancelAnimationFrame(request);
    request = undefined;
    previous = undefined;
    if (running()) request = globalThis.requestAnimationFrame(tick);
  }
  function tick(now) {
    request = undefined;
    if (!running()) return;
    elapsed += previous === undefined ? 0 : Math.min(100, now - previous);
    previous = now;
    if (stopAt !== undefined && elapsed >= stopAt) {
      elapsed = stopAt;
      frame(elapsed);
      stopAt = undefined;
      paused = true;
      update();
      return;
    }
    if (elapsed >= duration) {
      elapsed = 0;
      advance();
      if (reducedMotion()) elapsed = 0;
    }
    frame(reducedMotion() ? duration - 700 : elapsed);
    request = globalThis.requestAnimationFrame(tick);
  }
  function reset(time = 0) {
    elapsed = time;
    previous = undefined;
    stopAt = undefined;
    frame(elapsed);
  }
  const clock = {
    reset,
    pause() { paused = true; update(); },
    play() { paused = false; held = false; stopAt = undefined; if (reducedMotion()) elapsed = 0; update(); },
    hold(value) { held = value; update(); },
    seek(time) { reset(time); paused = true; update(); },
    segment(from, to) {
      reset(reducedMotion() ? to : from);
      stopAt = to;
      paused = reducedMotion();
      held = false;
      update();
    },
  };
  toggle.addEventListener("click", () => {
    paused = !paused;
    held = false;
    stopAt = undefined;
    if (!paused && reducedMotion()) elapsed = 0;
    update();
  });
  document.addEventListener("visibilitychange", update);
  if ("IntersectionObserver" in globalThis) {
    const observer = new globalThis.IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      update();
    }, { threshold: 0.05 });
    observer.observe(root);
  }
  motionPreference?.addEventListener("change", () => {
    if (reducedMotion()) paused = true;
    update();
  });
  frame(elapsed);
  update();
  return clock;
}

const agents = [
  { name: "Claude Code", image: "lobe-claudecode-color", task: "首页下拉回弹有点卡，帮我看看", reply: "把回弹交给原生滚动，手指离开，页面自然归位。", tool: "ChatView.swift", color: "#b4572e" },
  { name: "Codex", image: "lobe-codex-color", task: "对齐一下移动端的使用体验", reply: "从返回手势到按钮反馈，每一次操作，都有连贯的回应。", tool: "InteractionMotion.swift", color: "#006c64" },
  { name: "Pi", image: "pi", task: "梳理项目中的页面结构", reply: "已找到项目入口。我们从首页开始，把想法一步步变成现实。", tool: "src/pages", color: "#99482f" },
  { name: "Codex Desktop", image: "lobe-codex-color", task: "下载页按修改时间排序", reply: "最新的文件排在最前。电脑上的进展，手机上接着看。", tool: "DownloadView.swift", color: "#006c64" },
  { name: "DeepSeek", image: "deepseek", task: "检查服务端连接状态", reply: "正在检查连接与路由。结果会在同一段对话里继续更新。", tool: "Relay / health", color: "#4d6bfe" },
  { name: "ZCode", image: "lobe-zai", preview: true },
  { name: "OpenCode", image: "lobe-opencode", preview: true },
  { name: "Kimi Code", image: "lobe-kimi-color", preview: true },
  { name: "Oh My Pi", image: "omp-icon", preview: true },
  { name: "Hermes", image: "lobe-hermesagent", preview: true },
  { name: "OpenClaw", image: "lobe-openclaw-color", preview: true },
];

function setupOrbit() {
  const ring = byId("agent-ring");
  const stage = byId("orbit-stage");
  const picks = byId("agent-picks");
  const step = 360 / agents.length;
  let position = 0;
  let drag;
  let suppressClick = false;
  let clock;
  ring.replaceChildren();
  agents.forEach((agent, index) => {
    const card = document.createElement("article");
    card.className = "agent-card";
    card.dataset.agentIndex = String(index);
    card.style.setProperty("--angle", `${index * step}deg`);
    const front = agent.preview
      ? `${agentImage(agent.image, "card-brand")}<h2>${agent.name}</h2><p class="preview-label">即将接入</p>`
      : `<div class="card-heading">${agentImage(agent.image, "card-brand")}<div><h2>${agent.name}</h2><small>Orbis · 交互演示</small></div><span class="card-status"></span></div><p class="card-prompt">${agent.task}</p><p class="card-answer">${agent.reply}</p><div class="card-tool">↳ <span>${agent.tool}</span><span>✓</span></div><div class="card-composer">发给 ${agent.name}<span>↑</span></div>`;
    card.innerHTML = `<div class="agent-face${agent.preview ? " is-preview" : ""}">${front}</div><div class="agent-back">${agentImage(agent.image)}<span>${agent.name}</span></div>`;
    ring.append(card);
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "agent-pick";
    pick.dataset.preview = String(Boolean(agent.preview));
    pick.setAttribute("aria-label", `${agent.name}${agent.preview ? "，即将接入" : "，已接入"}`);
    pick.setAttribute("aria-pressed", String(index === 0));
    pick.title = agent.name;
    pick.innerHTML = agentImage(agent.image);
    pick.addEventListener("click", () => selectNearest(index));
    picks.append(pick);
  });
  const cards = [...ring.children];
  const buttons = [...picks.children];
  const normalized = value => ((value % agents.length) + agents.length) % agents.length;
  function select(next, manual = false) {
    position = next;
    const selected = normalized(position);
    ring.style.transform = `translateZ(calc(-1 * var(--radius))) rotateY(${-position * step}deg)`;
    cards.forEach((card, index) => {
      const distance = Math.min(normalized(index - selected), normalized(selected - index));
      card.classList.toggle("is-front", distance === 0);
      card.classList.toggle("is-near", distance === 1);
      buttons[index].setAttribute("aria-pressed", String(index === selected));
    });
    const agent = agents[selected];
    byId("agent-name").textContent = agent.name;
    byId("agent-availability").textContent = agent.preview ? "即将接入" : "已接入";
    byId("agent-name").parentElement.classList.toggle("is-preview", Boolean(agent.preview));
    if (manual) {
      clock.pause();
      clock.reset();
      byId("agent-announcement").textContent = `${agent.name}，${agent.preview ? "即将接入" : "已接入"}`;
    }
  }
  function selectNearest(index) {
    let delta = normalized(index - normalized(position));
    if (delta > agents.length / 2) delta -= agents.length;
    select(position + delta, true);
  }
  clock = createClock({
    root: byId("agents"), toggle: byId("orbit-play"), duration: 4800,
    frame() {}, advance() { select(position + 1); },
    labels: { play: "继续 Agent 自动旋转", pause: "暂停 Agent 自动旋转", shortPlay: "播放旋转", shortPause: "暂停旋转" },
  });
  select(0);
  byId("agent-prev").addEventListener("click", () => select(position - 1, true));
  byId("agent-next").addEventListener("click", () => select(position + 1, true));
  picks.addEventListener("keydown", event => {
    const focused = buttons.indexOf(document.activeElement);
    if (focused < 0) return;
    const target = event.key === "ArrowRight" ? normalized(focused + 1)
      : event.key === "ArrowLeft" ? normalized(focused - 1)
      : event.key === "Home" ? 0 : event.key === "End" ? agents.length - 1 : undefined;
    if (target === undefined) return;
    event.preventDefault();
    buttons[target].focus();
    selectNearest(target);
  });
  stage.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, position, id: event.pointerId, active: false };
    suppressClick = false;
    clock.hold(true);
  });
  stage.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.active && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
      drag = undefined;
      clock.hold(false);
      return;
    }
    if (!drag.active && Math.abs(dx) > 8) {
      drag.active = true;
      stage.setPointerCapture(event.pointerId);
      stage.classList.add("is-dragging");
    }
    if (!drag.active) return;
    const angle = -drag.position * step + dx * .16;
    ring.style.transform = `translateZ(calc(-1 * var(--radius))) rotateY(${angle}deg)`;
  });
  function endDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const wasDragging = drag.active;
    const next = wasDragging && event.type !== "pointercancel"
      ? drag.position - Math.round((event.clientX - drag.x) * .16 / step) : drag.position;
    drag = undefined;
    suppressClick = wasDragging;
    stage.classList.remove("is-dragging");
    clock.hold(false);
    select(next, wasDragging);
  }
  globalThis.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("click", event => {
    if (suppressClick) { suppressClick = false; return; }
    const card = event.target.closest("[data-agent-index]");
    if (card) selectNearest(Number(card.dataset.agentIndex));
  });
  byId("agents").addEventListener("focusin", event => {
    if (event.target !== byId("orbit-play")) clock.pause();
  });
}

const scenes = [
  { id: "chat", title: "一句话。<br>即刻出发。", description: "输入、飞入、流式展开。<br>对话跟得上你的思路。", marks: [650, 1200, 4400, 6200] },
  { id: "diff", title: "每一处改动。<br>都看得清。", description: "打开本轮文件差异。<br>轻轻翻页，逐一审阅。", marks: [2400, 5200] },
  { id: "download", title: "轻轻一点。<br>成果到手。", description: "文件从对话飞进下载。<br>下一步，随时带走。", marks: [900, 2100, 4300] },
  { id: "sessions", title: "一划，一选。<br>收放自如。", description: "左滑关闭，长按多选。<br>让会话跟着你的节奏走。", marks: [1000, 1650, 2200, 2500, 6100] },
  { id: "create", title: "一个新想法。<br>一个新开始。", description: "拉开目录，选择 Agent。<br>新会话，顺势来到眼前。", marks: [950, 2400, 4700] },
  { id: "quota", title: "轻翻一面。<br>心中有数。", description: "从小时到周，轻触切换。<br>配额也有自己的手感。", marks: [900, 2200, 4000, 6400] },
  { id: "pair", title: "抬手一扫。<br>就在身边。", description: "电脑里的 Agent。<br>从此，手机上接着聊。", marks: [600, 3200] },
];
const phoneButton = (action, glyph, label, extra = "") => `<button class="phone-icon ${extra}" type="button" data-action="${action}" aria-label="${label}">${icon(glyph)}</button>`;
const toolbar = (title, action = "home", end = "") => `<div class="phone-toolbar">${phoneButton(action, "arrow-left", "返回演示首页")}<strong>${title}</strong>${end}</div>`;
const homeToolbar = () => `<div class="phone-toolbar">${phoneButton("create-open", "menu", "打开新建会话演示")}<div class="toolbar-copy"><span class="phone-brand">Orbis</span><span class="phone-tag">Easy Agents Everywhere</span></div>${phoneButton("download-scene", "download", "查看下载演示")}${phoneButton("quota-scene", "gear", "查看配额演示")}</div>`;
const sessionRow = (index, image, title, status, extra = "") => `<div class="session-row ${extra}" data-row="${index}"><div class="swipe-underlay" aria-hidden="true">松手关闭</div><button type="button" class="session-main" data-action="select-session" data-index="${index}" aria-pressed="false"><span class="session-icon">${agentImage(image)}</span><span class="session-copy"><b>${title}</b><small>${status}</small></span><span class="session-indicator" aria-hidden="true">✓</span></button></div>`;
const homeFooter = `<div class="phone-footer">${icon("desktop")}<b>我的 MacBook</b><span>· 已连接</span></div>`;
const reply = "回弹交给原生滚动处理，手指松开后，列表自然归位。刷新指示器只负责显示，不再改变页面的位置。";

function sceneMarkup(id) {
  if (id === "chat") return `<div class="phone-toolbar">${phoneButton("home", "arrow-left", "查看会话演示")}<div class="toolbar-copy"><strong>首页下拉回弹优化</strong><small>Claude Code · 运行中</small></div>${phoneButton("download-scene", "download", "查看下载演示")}</div>
    <div class="recent-question">最近提问 · 首页下拉回弹有点卡，帮我看看</div>
    <div class="chat-thread"><div class="chat-user">首页下拉回弹有点卡，帮我看看</div><div class="chat-assistant"><div class="assistant-identity">${agentImage("lobe-claudecode-color")}Claude Code</div><p class="ink-reply" aria-label="${reply}">${[...reply].map(char => `<span class="ink-char" aria-hidden="true">${char}</span>`).join("")}</p><div class="tool-line">${icon("wrench")}<span>ChatView.swift</span><span class="done-check">✓</span></div><div class="chat-result">本轮文件差异 · 3 个文件</div></div></div>
    <div class="chat-path">${icon("folder")} /Projects/orbis</div><div class="chat-composer"><div class="composer-field" id="demo-composer">首页下拉回弹有点卡…</div>${phoneButton("send", "arrow-up", "演示发送消息", "send-button")}</div>`;
  if (id === "diff") return `${toolbar("本轮文件差异")}<div class="diff-summary">3 个文件<span>+ 24 · − 11</span></div><div class="diff-window">${[
    { file: "ChatView.swift", lines: [["dim","  42  // Keep the scroll view in control"],["","  43  ScrollView {"],["remove","− 44    refreshInset(height)"],["add","+ 44    observePullGesture()"],["add","+ 45    overlayRefreshIndicator()"],["","  46    conversationContent"],["","  47  }"],["","  48"],["add","+ 49  .onRelease { refresh() }"]] },
    { file: "HomePullRefresh.swift", lines: [["dim","   8  // One gesture, one refresh"],["","   9  func release() {"],["add","+ 10    guard isAtTop else { return }"],["add","+ 11    guard passedThreshold else {"],["add","+ 12      return"],["add","+ 13    }"],["","  14    onRefresh()"],["","  15  }"]] },
    { file: "HomePullRefreshTests.swift", lines: [["dim","  18  @Test"],["add","+ 19  func ignoresShortPull() {"],["add","+ 20    refresh.drag(distance: 12)"],["add","+ 21    refresh.release()"],["add","+ 22    #expect(refresh.count == 0)"],["add","+ 23  }"],["","  24"],["dim","  25  // All checks passed"]] },
  ].map((page, index) => `<div class="diff-page${index === 0 ? " is-current" : ""}" data-page="${index}"><div class="diff-path">${page.file}</div><pre class="diff-code">${page.lines.map(([kind, text]) => `<span class="code-line ${kind}">${text}</span>`).join("")}</pre></div>`).join("")}</div><div class="diff-bottom">${phoneButton("diff-prev", "chevron-left", "上一个文件")}<span id="diff-page-label">1 / 3</span>${phoneButton("diff-next", "chevron-right", "下一个文件")}</div><p class="diff-scope">示例差异 · 左右翻页查看</p>`;
  if (id === "download") return `${toolbar("文件", "home", phoneButton("download-open", "download", "打开演示下载列表"))}<div class="phone-body download-source-view"><div class="assistant-identity">${agentImage("lobe-claudecode-color")}Claude Code</div><p class="download-message">已经整理好了。<br>代码和说明，都在这里。</p>${["回弹优化说明.md", "页面预览.png"].map((name, index) => `<button class="file-card" type="button" data-action="download-file" data-file="${index}">${icon("doc")}<span class="file-copy"><b>${name}</b><small>${index ? "PNG · 184 KB" : "Markdown · 3.2 KB"}</small></span><span class="file-status">↓</span></button>`).join("")}<p class="download-confirm">✓ 已加入演示下载列表</p></div><div class="file-flyer" aria-hidden="true">${icon("doc")}</div><div class="file-flyer second" aria-hidden="true">${icon("doc")}</div><div class="phone-body download-saved-view"><p class="settings-label">已下载 · 2 个文件</p>${["回弹优化说明.md", "页面预览.png"].map(name => `<div class="file-card">${icon("doc")}<span class="file-copy"><b>${name}</b><small>下载完成</small></span><span class="file-status">✓</span></div>`).join("")}</div>`;
  if (id === "sessions") return `<div class="phone-toolbar">${phoneButton("session-reset", "menu", "重置会话演示")}<strong id="session-title">Orbis</strong><button class="selection-close" data-action="close-selected" type="button" hidden>关闭所选</button></div><div class="session-list">${sessionRow(0,"lobe-claudecode-color","首页下拉回弹优化","Claude Code · 已完成")}${sessionRow(1,"lobe-codex-color","对齐移动端的使用体验","Codex · 空闲")}${sessionRow(2,"pi","梳理项目中的页面结构","Pi · 空闲")}${sessionRow(3,"deepseek","检查服务端连接状态","DeepSeek · 运行中")}</div><p class="session-hint">左滑第一张卡片 · 点按或长按多选</p>${homeFooter}`;
  if (id === "create") return `${homeToolbar()}<div class="session-list">${sessionRow(4,"lobe-claudecode-color","一个新想法","Claude Code · 新会话","new-session-card")}${sessionRow(0,"lobe-codex-color","对齐移动端的使用体验","Codex · 空闲")}${sessionRow(1,"pi","梳理项目中的页面结构","Pi · 空闲")}</div><button class="add-demo-button" type="button" data-action="create-open">${icon("plus")}新建会话</button>${homeFooter}<div class="new-session-sheet"><div class="sheet-handle"></div><h4>新建会话</h4><p class="sheet-label">选择 Agent</p><div class="sheet-agents">${agents.slice(0,3).map((agent,index) => `<button class="sheet-agent${index === 0 ? " is-selected" : ""}" data-action="create-agent" data-agent="${index}" type="button" aria-pressed="${index === 0}">${agentImage(agent.image)}${agent.name}</button>`).join("")}</div><p class="sheet-label">工作目录</p><div class="sheet-project">/Projects/orbis</div><button class="sheet-submit" data-action="create-submit" type="button">创建会话</button></div>`;
  if (id === "quota") return `${toolbar("设置")}<div class="phone-body"><p class="settings-label">订阅与配额</p><div class="provider-card"><div class="quota-static">${agentImage("lobe-codex-color")}</div><div class="provider-copy"><b>Codex</b><small>订阅配额</small><div class="quota-caption">5 小时 · 剩余 63%</div></div></div><div class="provider-card"><div class="provider-copy"><b>Claude Code</b><small>订阅配额</small><div class="quota-caption" id="quota-caption">点击图标查询</div></div><button class="quota-coin-button" type="button" data-action="coin" aria-label="查询演示配额">${agentImage("lobe-claudecode-color","coin-agent")}<span class="quota-coin" aria-hidden="true">${Array.from({length:13},(_,i)=>`<span class="coin-edge" data-depth="${i-6}"></span>`).join("")}<span class="coin-face"><span>5h<br><b>72%</b></span></span><span class="coin-face back"><span>周<br><b>41%</b></span></span></span></button></div><p class="quota-tip">点一下，查询。<br>再点一下，翻到另一面。</p></div>`;
  return `${toolbar("添加电脑")}<h4 class="pair-heading">让电脑和手机<br>认识一下。</h4><div class="pair-frame"><img src="assets/promo/qr-orbising.svg" alt="Orbis 官网演示二维码"><span class="scan-line" aria-hidden="true"></span></div><p class="pair-status">对准电脑上的二维码</p><button type="button" class="pair-action" data-action="scan">${icon("qrscan")} 演示扫码</button><p class="pair-note">此二维码打开 Orbis 官网。<br>这里演示连接过程，不会配对真实电脑。</p>`;
}

function setupDemo() {
  const root = byId("feature-demo");
  const content = byId("phone-content");
  const phone = byId("demo-phone");
  const tabs = [...root.querySelectorAll("[data-scene]")];
  let current = 0;
  let time = 0;
  let cachedPhase = -1;
  let cachedChars = -1;
  let manualSelection = false;
  let manualBatch = false;
  let selected = new Set();
  let chosenAgent = 0;
  let clock;
  let swipe;
  let longPress;
  let ignoreClick = false;
  window.OrbisPhone?.build(phone, { screen: byId("phone-screen"), thickness: 30 });

  function selectScene(index, manual = false) {
    current = (index + scenes.length) % scenes.length;
    const scene = scenes[current];
    cachedPhase = -1;
    cachedChars = -1;
    manualSelection = false;
    manualBatch = false;
    selected = new Set();
    chosenAgent = 0;
    content.innerHTML = sceneMarkup(scene.id);
    content.className = "phone-content";
    content.setAttribute("aria-labelledby", `tab-${scene.id}`);
    phone.dataset.scene = scene.id;
    byId("chapter-index").textContent = `${String(current + 1).padStart(2, "0")} / 07`;
    byId("chapter-title").innerHTML = scene.title;
    byId("chapter-description").innerHTML = scene.description;
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === current));
      tab.tabIndex = i === current ? 0 : -1;
    });
    content.querySelectorAll(".coin-edge").forEach(edge => edge.style.setProperty("--depth", `${edge.dataset.depth}px`));
    if (clock) {
      clock.reset(reducedMotion() ? 7200 : 0);
      if (manual) {
        clock.pause();
        byId("demo-announcement").textContent = tabs[current].textContent.trim();
        if (!reducedMotion()) clock.segment(0, 7800);
      }
    }
    renderFrame(reducedMotion() ? 7200 : 0);
  }

  function renderSessions(phase) {
    if (!manualSelection) selected = new Set(time >= 3800 ? [1,2] : []);
    content.querySelectorAll(".session-row").forEach(row => {
      const index = Number(row.dataset.row);
      const isSelected = selected.has(index);
      row.classList.toggle("selected", isSelected);
      row.querySelector("button").setAttribute("aria-pressed", String(isSelected));
      const closed = (!manualBatch && phase >= 4 && index === 0) || (phase >= 5 && isSelected);
      row.inert = closed;
      row.setAttribute("aria-hidden", String(closed));
    });
    const count = phase >= 5 ? 0 : selected.size;
    byId("session-title").textContent = count ? `已选择 ${count} 项` : "Orbis";
    content.querySelector(".selection-close").hidden = count === 0;
  }

  function renderFrame(elapsed) {
    time = elapsed;
    const scene = scenes[current];
    const phase = scene.marks.filter(mark => elapsed >= mark).length;
    byId("chapter-progress").style.transform = `scaleX(${clamp(elapsed / 8500,0,1)})`;
    if (cachedPhase !== phase) {
      cachedPhase = phase;
      for (let i = 1; i <= 5; i++) content.classList.toggle(`phase-${i}`, phase >= i);
      if (scene.id === "chat") byId("demo-composer").textContent = phase >= 1 ? "发给 Claude Code，/ 命令" : "首页下拉回弹有点卡…";
      if (scene.id === "diff") {
        content.querySelectorAll(".diff-page").forEach((page,i) => {
          page.classList.toggle("is-current", i === phase);
          page.setAttribute("aria-hidden", String(i !== phase));
        });
        byId("diff-page-label").textContent = `${phase + 1} / 3`;
      }
      if (scene.id === "download") {
        content.querySelector("[data-action=download-open]").classList.toggle("has-files", phase >= 2);
        content.querySelectorAll(".download-source-view .file-status").forEach(label => label.textContent = phase >= 2 ? "✓" : "↓");
      }
      if (scene.id === "create") {
        const sheet = content.querySelector(".new-session-sheet");
        const open = phase >= 1 && phase < 3;
        sheet.inert = !open;
        sheet.setAttribute("aria-hidden", String(!open));
        const newCard = content.querySelector(".new-session-card");
        newCard.inert = phase < 3;
        newCard.setAttribute("aria-hidden", String(phase < 3));
      }
      if (scene.id === "quota") {
        const button = content.querySelector(".quota-coin-button");
        button.classList.toggle("queried", phase >= 2);
        button.setAttribute("aria-label", phase < 2 ? "查询演示配额" : phase === 3 ? "本周剩余 41%，点击查看 5 小时配额" : "5 小时剩余 72%，点击查看本周配额");
        byId("quota-caption").innerHTML = phase === 1 ? '<span class="quota-loading" aria-hidden="true"></span> 查询中' : phase < 1 ? "点击图标查询" : phase === 3 ? "本周 · 剩余 41%" : "5 小时 · 剩余 72%";
      }
      if (scene.id === "pair") content.querySelector(".pair-status").textContent = phase >= 2 ? "✓ 演示完成 · iPhone 已连接" : "对准电脑上的二维码";
    }
    if (scene.id === "chat") {
      const chars = clamp(Math.floor((elapsed - 1300) / 40), 0, reply.length);
      if (chars !== cachedChars) {
        cachedChars = chars;
        content.querySelectorAll(".ink-char").forEach((span,i) => span.classList.toggle("is-visible", i < chars));
      }
    }
    if (scene.id === "sessions") renderSessions(phase);
    if (scene.id === "quota") {
      // Match the film's 220ms cubic-in / 340ms quartic-out flip, including its copper edge.
      const flip = start => {
        const t = elapsed - start;
        if (t <= 0) return 0;
        if (t < 220) return 90 * (t / 220) ** 3;
        return 90 + 90 * (1 - (1 - clamp((t - 220) / 340, 0, 1)) ** 4);
      };
      content.querySelector(".quota-coin").style.setProperty("--coin-angle", `${flip(4000) + flip(6400)}deg`);
    }
    if (scene.id === "pair") content.querySelector(".scan-line").style.setProperty("--scan-y", `${clamp((elapsed - 600) / 2400,0,1) * 190}px`);
  }
  selectScene(0);
  clock = createClock({ root, toggle: byId("demo-play"), duration: 8500, frame: renderFrame,
    advance() { selectScene(current + 1); },
    labels: { play: "继续功能演示", pause: "暂停功能演示", shortPlay: "播放", shortPause: "暂停" },
  });
  if (reducedMotion()) clock.seek(7200);
  tabs.forEach((tab,index) => tab.addEventListener("click", () => selectScene(index,true)));
  root.querySelector(".chapter-tabs").addEventListener("keydown", event => {
    const next = event.key === "ArrowRight" ? (current+1)%scenes.length : event.key === "ArrowLeft" ? (current+scenes.length-1)%scenes.length : event.key === "Home" ? 0 : event.key === "End" ? scenes.length-1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    tabs[next].focus();
    selectScene(next,true);
  });
  byId("demo-replay").addEventListener("click", () => { selectScene(current); clock.segment(0,7800); });
  content.addEventListener("focusin", () => clock.pause());
  motionPreference?.addEventListener("change", () => { if (reducedMotion()) clock.seek(7200); });
  const go = id => { selectScene(scenes.findIndex(scene=>scene.id===id),true); tabs[current].focus(); };
  content.addEventListener("click", event => {
    const button = event.target.closest("[data-action]");
    if (!button || button.closest("[inert]")) return;
    if (ignoreClick) { ignoreClick = false; return; }
    const action = button.dataset.action;
    if (action === "home") return go("sessions");
    if (action === "download-scene") return go("download");
    if (action === "quota-scene") return go("quota");
    if (action === "send") return clock.segment(500,4800);
    if (action === "diff-prev" || action === "diff-next") {
      const page = (cachedPhase + (action === "diff-next" ? 1 : 2)) % 3;
      clock.seek([0,2500,5300][page]);
    }
    if (action === "download-file") clock.segment(750,2400);
    if (action === "download-open") { tabs[current].focus(); clock.segment(4000,4600); }
    if (action === "select-session") {
      if (scenes[current].id !== "sessions") return go("chat");
      clock.pause();
      manualSelection = true;
      const index = Number(button.dataset.index);
      if (selected.has(index)) selected.delete(index); else selected.add(index);
      renderSessions(cachedPhase);
    }
    if (action === "session-reset") { selectScene(current); clock.pause(); }
    if (action === "close-selected") {
      manualBatch = time < 2500;
      content.classList.toggle("manual-batch", manualBatch);
      tabs[current].focus();
      clock.segment(5900,6600);
    }
    if (action === "create-open") {
      if (scenes[current].id !== "create") go("create");
      clock.segment(800,1800);
    }
    if (action === "create-agent") {
      clock.pause();
      chosenAgent = Number(button.dataset.agent);
      content.querySelectorAll(".sheet-agent").forEach((item,i) => {
        item.classList.toggle("is-selected",i===chosenAgent);
        item.setAttribute("aria-pressed",String(i===chosenAgent));
      });
    }
    if (action === "create-submit") {
      const agent = agents[chosenAgent];
      content.querySelector(".new-session-card .session-icon").innerHTML = agentImage(agent.image);
      content.querySelector(".new-session-card small").textContent = `${agent.name} · 新会话`;
      tabs[current].focus();
      clock.segment(4400,5300);
    }
    if (action === "coin") {
      if (time < 2200) clock.segment(700,2700);
      else if (time >= 4000 && time < 6400) clock.segment(6300,7100);
      else clock.segment(3900,4700);
    }
    if (action === "scan") clock.segment(0,3700);
  });
  // Horizontal drag closes a demo session; vertical gestures still scroll the website.
  content.addEventListener("pointerdown", event => {
    const row = event.target.closest(".session-main");
    if (!row || scenes[current].id !== "sessions" || event.button !== 0) return;
    ignoreClick = false;
    swipe = { x:event.clientX,y:event.clientY,id:event.pointerId,row,active:false };
    longPress = globalThis.setTimeout(() => {
      if (!swipe) return;
      row.click();
      ignoreClick = true;
    }, 450);
  });
  content.addEventListener("pointermove", event => {
    if (!swipe || event.pointerId !== swipe.id) return;
    const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
    if (Math.hypot(dx,dy)>8) globalThis.clearTimeout(longPress);
    if (Math.abs(dy)>Math.abs(dx) && Math.abs(dy)>8) { swipe=undefined; return; }
    if (Number(swipe.row.dataset.index)!==0 || Math.abs(dx)<8) return;
    swipe.active = true;
    swipe.row.setPointerCapture(event.pointerId);
    clock.pause();
    swipe.row.style.transform=`translateX(${clamp(dx,-160,0)}px)`;
  });
  function finishSwipe(event) {
    globalThis.clearTimeout(longPress);
    if (!swipe || swipe.id!==event.pointerId) return;
    const old=swipe;
    swipe=undefined;
    old.row.style.transform="";
    if (old.active) {
      ignoreClick=true;
      if (event.type!=="pointercancel" && event.clientX-old.x < -65) clock.segment(1600,2800);
      else clock.seek(0);
    }
  }
  globalThis.addEventListener("pointerup",finishSwipe);
  content.addEventListener("pointercancel",finishSwipe);
}

revealHeadline();
setupOrbit();
setupDemo();
