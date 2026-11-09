/* Local interactive versions of the approved draft, directory and provider flows. */
window.OrbisDemoPolicy = {
  canSend(text) { return text.trim().length > 0; },
  swipeArmed(distance, width) { return distance >= width * 0.4; },
  dialGeometry(width = 393, height = 360) {
    const r0=Math.max(140,Math.min(Math.round(width*.52),Math.floor(height/2)-28,width-76-28-136));
    const rim=r0+Math.round(Math.max(22,Math.min(30,r0*.15)))+24,radius=Math.round(r0*1.6),cx=rim-radius,cy=height/2;
    const hole=Math.max(Math.round(Math.max(22,Math.min(44,radius*.15))),26-cx),hub=Math.max(Math.round(radius*.5),hole+72);
    const agentRadius=Math.round((hole+hub)/2)+2;
    return {width,height,rim,radius,cx,cy,hole,hub,seam:hub+24,agentRadius,step:Math.round(Math.max(16,Math.min(24,96/(radius+28)*180/Math.PI))),agentStep:Math.round(Math.max(24,Math.min(40,56/agentRadius*180/Math.PI)))};
  },
  dialLayer(x, y, touch, geometry) {
    if(touch && x<20)return null;
    const g=geometry||this.dialGeometry(),distance=Math.hypot(x-g.cx,y-g.cy);
    return distance<g.hole?null:distance<g.hub?"agent":distance<g.seam?null:"profile";
  },
  dialIndex(layer, start, distance) { return Math.max(0, Math.min(3, start + Math.round(-distance / (layer === "agent" ? 84 : 96)))); },
  dialRelease(layer, position, velocity) { return Math.max(0,Math.min(3,Math.round(position+(layer==="profile"?velocity*140:0)))); },
  profileAction(agent, active, moving) { return { disabled: moving || agent !== 0 && active, label: agent === 0 ? (active ? "移出 " : "启用 ") : active ? "正在使用 " : "切换到 " }; },
};
window.createOrbisDesignDemo = function ({ screen, scene, reduced, onPlayback }) {
  const policy = window.OrbisDemoPolicy;
  const agents = [
    { id: "pi", name: "Pi", icon: "pi.svg" },
    { id: "codex", name: "Codex", icon: "codex.svg" },
    { id: "deepseek", name: "DeepSeek", icon: "deepseek.svg" },
    { id: "claude", name: "Claude Code", icon: "claude.svg" },
  ];
  const agentOrder=[1,3,2,0];
  const profiles = ["本机配置", "relay-b", "openrouter", "azure"];
  const appearance=window.orbisAppearance;
  const currentAppearance=()=>appearance?.current()||{material:"mist",mode:"system",dark:false};
  const root = document.createElement("div"); root.className = "design-demo"; root.id = "design-demo";
  const chrome = [...screen.querySelectorAll("#s4-home > .ui-time,#s4-home > .ui-sys")].map(el => el.outerHTML).join("");
  const esc = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const icon = name => `<i class="ico i-${name}" aria-hidden="true"></i>`;
  const mark = agent => `<span class="demo-agentmark demo-mark-${agent.id}" role="img" aria-label="${agent.name}"></span>`;
  const button = (action, label, name, extra = "") => `<button type="button" class="demo-icon" data-demo-action="${action}" aria-label="${label}" ${extra}>${icon(name)}</button>`;
  const codexName = variant => variant === "desktop" ? "Codex 桌面版" : "Codex 终端版";
  const sessionAgentName = session => session.agent === 1 ? codexName(session.codexVariant) : agents[session.agent].name;
  const protocolName = value => ({auto:"自动",ws:"WebSocket",quic:"QUIC"})[value];
  const state = { codexVariant: "terminal", codexMenu: null, protocolInfo: false, page: scene === "quota" ? "providers" : "home", draft: false, text: "", directory: "/Projects/orbis", agent: 1, profile: 0, active: [0,0,0,0], piEnabled: new Set([0]), drawer: false, search: "", expanded: new Set(["/Projects/orbis"]), selected: new Set(), moving: false, dialog: false, protocolSheet: false, languageSheet: false, language: "system", draftLanguage: "system", directorySheet: false, protocol: "auto", draftProtocol: "auto", notice: "" };
  let sessions = [
    { id: 1, title: "统一子代理逻辑并添加界面提示", directory: "/Projects/orbis", agent: 2, status: "运行中", tone: "success", syncing: true },
    { id: 2, title: "配置 iOS 应用 TestFlight 上传", directory: "/Projects/orbis", agent: 1 },
    { id: 3, title: "新拟物菜单栏设计稿实现", directory: "/Projects/orbis", agent: 3, status: "等待审批", tone: "warning" },
    { id: 4, title: "整理下载记录与回收空间", directory: "/Projects/website", agent: 0 },
    { id: 5, title: "修复 QUIC 重连后的历史停顿", directory: "/Projects/orbis", agent: 1 },
  ];
  let nextId = 6, gesture, selectionHold, dialAnimation=0, playback = [], animations = [], playing = false, disposed = false, suppressClick = false;
  const $ = selector => root.querySelector(selector);
  const duration = ms => reduced() ? 0 : ms;
  function motion(element, frames, ms, easing = "cubic-bezier(.2,0,0,1)") {
    if (!element || !element.animate) return Promise.resolve();
    const animation = element.animate(frames, { duration: duration(ms), easing }); animations.push(animation);
    return animation.finished.catch(() => {});
  }
  function stopPlayback() {
    playback.forEach(window.clearTimeout); playback = []; animations.forEach(animation => animation.cancel()); animations = [];
    playing = false; onPlayback(false);
  }
  function render() {
    if (disposed) return;
    const agent = agents[state.agent];
    root.dataset.agent = agent.id; root.dataset.page = state.page; root.dataset.selecting = String(state.selected.size > 0); root.dataset.moving = String(state.moving);
    root.innerHTML = chrome + `<div class="demo-content">${state.page === "home" ? home() : state.page === "providers" ? providers() : state.page === "settings" ? settings() : state.page === "downloads" ? downloads() : chat()}</div>${state.drawer ? drawer() : ""}${state.codexMenu ? `<div class="demo-menu-scrim" data-demo-action="codex-menu-close"></div>` : ""}${state.dialog ? confirmation() : ""}${state.protocolSheet ? protocolSheet() : ""}${state.languageSheet ? languageSheet() : ""}${state.protocolInfo ? protocolInfo() : ""}${state.directorySheet ? directorySheet() : ""}${state.notice ? `<div class="demo-notice" role="status">${esc(state.notice)}${button("notice-close","关闭提示","close")}</div>` : ""}<div class="film-home-indicator"></div>`;
    layoutDial();
    for(const el of root.querySelectorAll("[data-remaining]"))el.style.width=`${el.dataset.remaining}%`;
  }
  function home() {
    return `<header class="demo-topbar">${button("drawer-open","打开会话目录","menu")}<div class="demo-wordmark"><b>Orbis</b><small>Easy Agents Everywhere</small></div>${button("downloads","下载","download")}${button("draft-toggle",state.draft?"收起草稿":"新建会话",state.draft?"close":"plus")}</header><div class="demo-home-scroll"><div class="demo-computer">${icon("desktop")}<strong>workstation</strong><span class="demo-connected"><i class="demo-dot"></i>局域网${icon("lock")}</span></div>${state.selected.size ? `<div class="demo-batch"><span>已选择 ${state.selected.size} 项</span><button type="button" class="demo-text-button danger" data-demo-action="close-selected">关闭会话</button><button type="button" class="demo-text-button" data-demo-action="selection-cancel">取消</button></div>` : ""}${state.draft ? draft() : ""}<div class="demo-session-list">${sessions.map(session => sessionCard(session)).join("")}</div></div>${tabs("home")}`;
  }
  function sessionCard(session) {
    const agent = agents[session.agent];
    return `<div class="demo-session-wrap"><div class="demo-swipe-feedback" aria-hidden="true"><span class="demo-swipe-seat">${icon("close")}<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" pathLength="100"></circle></svg></span><span class="demo-swipe-label">关闭</span></div><article class="demo-session" role="button" tabindex="0" data-session="${session.id}" aria-label="${esc(session.title)}，${sessionAgentName(session)}，${session.status||"空闲"}" aria-pressed="${state.selected.has(session.id)}"><span class="demo-emblem">${mark(agent)}</span><div class="demo-session-text"><strong>${esc(session.title)}</strong><code>${esc(session.directory)}</code><span><b class="agent-${agent.id}">${sessionAgentName(session)}</b><i class="demo-dot ${session.syncing?"syncing":session.tone||"idle"}"></i>${session.status||"空闲"}</span></div><button type="button" class="demo-session-select" data-demo-action="select-session" data-id="${session.id}" aria-label="${state.selected.has(session.id)?"取消选择":"选择"} ${esc(session.title)}">${icon(state.selected.has(session.id)?"check":"more")}</button></article></div>`;
  }
  function draft() {
    return `<section class="demo-draft" aria-label="新建会话草稿"><div class="demo-agent-choices" role="group" aria-label="Agent">${agentOrder.map(index=>{const agent=agents[index];return `<button type="button" class="demo-agent-choice agent-${agent.id}" data-demo-action="draft-agent" data-index="${index}" aria-label="${agent.name}" aria-pressed="${state.agent===index}">${mark(agent)}</button>`;}).join("")}${state.agent===1?`<span class="demo-codex-anchor"><button type="button" class="demo-draft-agent-name demo-codex-trigger" data-demo-action="codex-menu" aria-label="选择 Codex 版本" aria-haspopup="menu" aria-expanded="${!!state.codexMenu}">${codexName(state.codexVariant)}${icon("chevron-down")}</button>${state.codexMenu?codexMenu():""}</span>`:`<strong class="demo-draft-agent-name">${agents[state.agent].name}</strong>`}</div><button type="button" class="demo-directory-label" data-demo-action="draft-directory" aria-label="工作目录" id="demo-draft-directory">${icon("folder")}<span>${esc(state.directory)}</span>${icon("chevron-down")}</button><div class="demo-draft-compose"><label class="demo-draft-input"><textarea id="demo-first-message" aria-label="第一句话" placeholder="让 ${state.agent===1?codexName(state.codexVariant):agents[state.agent].name} 做什么？">${esc(state.text)}</textarea></label>${button("draft-send","发送第一句话","arrow-up",policy.canSend(state.text)?"":"disabled")}</div><div class="demo-draft-footer"><small>发出第一句话，才会在电脑上创建这个会话</small></div></section>`;
  }
  function codexMenu() {
    return `<div class="demo-codex-menu" role="menu" aria-label="Codex 版本">${["terminal","desktop"].map(variant=>`<button type="button" role="menuitemradio" aria-checked="${state.codexVariant===variant}" data-demo-action="codex-variant" data-value="${variant}"><span>${codexName(variant)}</span>${state.codexVariant===variant?icon("check"):""}</button>`).join("")}</div>`;
  }
  function tabs(active) {
    return `<nav class="demo-tabs" aria-label="主导航">${[["home","聊天","chat"],["providers","供应商","tune"],["settings","设置","gear"]].map(([id,label,name])=>`<button type="button" data-demo-action="tab" data-page="${id}" aria-current="${active===id?"page":"false"}">${icon(active===id?name+"-fill":name)}<span>${label}</span></button>`).join("")}</nav>`;
  }
  function drawer() {
    const groups=["/Projects/orbis","/Projects/website"];
    return `<div class="demo-drawer-scrim" data-demo-action="drawer-close"></div><aside class="demo-drawer" aria-label="会话目录"><header><strong>会话目录</strong>${button("drawer-close","关闭会话目录","close")}</header><label class="demo-search">${icon("search")}<input id="demo-directory-search" value="${esc(state.search)}" placeholder="搜索会话或目录" aria-label="搜索会话或目录"></label><div class="demo-tree">${groups.map(directory=>`<section class="demo-tree-group"><button type="button" class="demo-tree-heading" data-demo-action="directory-toggle" data-directory="${directory}" aria-expanded="${state.expanded.has(directory)}">${icon("folder")}<span>${directory.split("/").pop()}</span><small>${sessions.filter(session=>session.directory===directory).length}</small>${icon("chevron-right")}</button>${state.expanded.has(directory)?`<div class="demo-tree-branches">${sessions.filter(session=>session.directory===directory && `${session.title} ${directory}`.toLowerCase().includes(state.search.toLowerCase())).map(session=>`<button type="button" class="demo-tree-session" data-demo-action="session-open" data-id="${session.id}">${mark(agents[session.agent])}<span>${esc(session.title)}</span></button>`).join("")}<button type="button" class="demo-tree-new" data-demo-action="directory-new" data-directory="${directory}">${icon("plus")}新建会话</button></div>`:""}</section>`).join("")}</div></aside>`;
  }
  function layoutDial() {
    const dial=$(".demo-dial");if(!dial)return;
    const g=policy.dialGeometry(dial.clientWidth,dial.clientHeight),ring=(element,radius)=>Object.assign(element.style,{left:`${g.cx-radius}px`,top:`${g.cy-radius}px`,width:`${radius*2}px`,height:`${radius*2}px`});
    ring($(".demo-dial-disc"),g.radius);ring($(".demo-dial-moat"),g.seam);ring($(".demo-dial-hub"),g.hub);ring($(".demo-dial-hollow"),g.hole);
    dial.classList.toggle("is-cropped",g.radius>g.height/2-20);
    const selected=state.dragAgent??agentOrder.indexOf(state.agent),position=state.dragProfile??state.profile;
    for(const el of root.querySelectorAll(".demo-dial-agent")){
      const a=(agentOrder.indexOf(Number(el.dataset.index))-selected)*g.agentStep*Math.PI/180,x=g.cx+Math.cos(a)*g.agentRadius;
      el.hidden=x<22;el.style.left=`${g.hub+Math.cos(a)*g.agentRadius-24}px`;el.style.top=`${g.hub+Math.sin(a)*g.agentRadius-24}px`;
    }
    for(const el of root.querySelectorAll(".demo-dial-profile")){
      const delta=Number(el.dataset.index)-position,a=delta*g.step*Math.PI/180,x=g.cx+(g.radius+28)*Math.cos(a);
      Object.assign(el.style,{left:`${x}px`,top:`${g.cy+(g.radius+28)*Math.sin(a)}px`,maxWidth:`${Math.max(80,g.width-x-8)}px`,opacity:String(1-.4*Math.min(2,Math.abs(delta))),transform:`translateY(-50%) scale(${1-.22*Math.min(1,Math.abs(delta))})`});
      el.hidden=Math.abs(delta*g.step)>56;
    }
    Object.assign($(".demo-dial-pointer").style,{left:`${g.rim+9}px`,top:`${g.cy-4}px`});
    Object.assign($(".demo-dial-window").style,{left:`${g.cx+g.agentRadius-21}px`,top:`${g.cy-21}px`});
    let ticks="";
    for(let k=0;k<Math.round(360/(g.step/8));k++){
      const a=(k*g.step/8-position*g.step)*Math.PI/180,major=k%8===0,mid=k%4===0,r0=g.radius-(major?18:mid?13:10),r1=g.radius-6;
      ticks+=`<path class="${major?"is-major":""}" d="M ${g.cx+r0*Math.cos(a)} ${g.cy+r0*Math.sin(a)} L ${g.cx+r1*Math.cos(a)} ${g.cy+r1*Math.sin(a)}"/>`;
    }
    for(let k=0;k<45;k++){const a=k*8*Math.PI/180,r=g.hub-8;ticks+=`<circle cx="${g.cx+r*Math.cos(a)}" cy="${g.cy+r*Math.sin(a)}" r="1.5"/>`;}
    for(let index=0;index<profiles.length;index++){const a=(index-position)*g.step*Math.PI/180,r=g.radius-32;ticks+=`<circle class="demo-profile-dot ${index===state.active[state.agent]?"is-current":""}" cx="${g.cx+r*Math.cos(a)}" cy="${g.cy+r*Math.sin(a)}" r="3"/>`;}
    const svg=$(".demo-dial-ticks");svg.setAttribute("viewBox",`0 0 ${g.width} ${g.height}`);svg.innerHTML=ticks;
  }
  function providers() {
    const agent=agents[state.agent], active=state.agent===0?state.piEnabled.has(state.profile):state.active[state.agent]===state.profile;
    const action=policy.profileAction(state.agent,active,state.moving);
    return `<header class="demo-topbar"><h2>供应商</h2></header><div class="demo-provider-flow"><div class="demo-provider-host">${icon("desktop")}<strong>workstation</strong><small>4 个配置</small></div><div class="demo-dial" role="group" aria-label="供应商配置" data-agent="${agent.id}"><div class="demo-dial-disc"></div><div class="demo-dial-moat"></div><div class="demo-dial-hub" role="slider" tabindex="0" data-dial-layer="agent" aria-label="Agent" aria-valuemin="0" aria-valuemax="3" aria-valuenow="${state.agent}" aria-valuetext="${agent.name}">${agentOrder.map(index=>{const item=agents[index];return `<button type="button" class="demo-dial-agent" data-demo-action="dial-agent" data-index="${index}" tabindex="-1" aria-label="${item.name}" aria-pressed="${index===state.agent}">${mark(item)}</button>`;}).join("")}</div><div class="demo-dial-window"></div><div class="demo-dial-hollow"></div><svg class="demo-dial-ticks" aria-hidden="true"></svg><div class="demo-dial-labels" role="slider" tabindex="0" data-dial-layer="profile" aria-label="${agent.name} 的配置" aria-valuemin="0" aria-valuemax="3" aria-valuenow="${state.profile}" aria-valuetext="${profiles[state.profile]}">${profiles.map((profile,index)=>`<button type="button" class="demo-dial-profile" data-demo-action="dial-profile" data-index="${index}" tabindex="-1" aria-pressed="${index===state.profile}">${index===state.profile?`<small>${agent.name}</small>`:""}<strong>${profile}</strong>${index===state.profile?`<small>${index===0?"ChatGPT 登录，官方":"API Key，自建中转"}</small>${active?`<span class="demo-dial-current">${icon("check")}使用中</span>`:""}`:""}</button>`).join("")}</div><span class="demo-dial-pointer agent-${agent.id}"></span></div><div class="demo-quota">${state.profile===0?quotaWindow("5 小时",state.agent===3?63:86,state.agent===3?"3 小时 5 分后重置":"2 小时 14 分后重置")+quotaWindow("7 天",state.agent===3?18:41,state.agent===3?"11 月 10 日 21:00 重置":"11 月 12 日 09:00 重置"): '<p class="demo-quota-empty">这个配置不提供配额查询</p>'}</div><button type="button" class="demo-primary demo-apply" data-demo-action="provider-apply" ${action.disabled?"disabled":""}>${active&&state.agent!==0?icon("check"):""}${action.label}${profiles[state.profile]}</button><p class="demo-dial-position" aria-label="配置位置">${state.profile+1} / 4</p></div>${tabs("providers")}`;
  }
  function quotaWindow(label,remaining,reset) {
    return `<section class="demo-quota-window${remaining<=20?" danger":""}"><div>${label}${remaining<=20?`<span>${icon("warning")}即将用完</span>`:""}</div><strong>${remaining}<small>%</small></strong><div class="demo-progress"><i data-remaining="${remaining}"></i></div><small>${reset}</small></section>`;
  }
  function preview(theme) {
    const card=live=>`<span class="demo-preview-card"><i class="demo-preview-dot ${live?"is-live":""}"></i><span><i></i><i></i></span></span>`;
    return `<span class="demo-theme-preview" data-ob="${theme}" aria-hidden="true"><i class="demo-preview-bar"></i>${card(true)}${card(false)}<span class="demo-preview-field"><i></i></span></span>`;
  }
  function settings() {
    const pref=currentAppearance(),theme=dark=>`${pref.material==="sage"?"sage-":""}${dark?"dark":"light"}`;
    return `<header class="demo-topbar"><h2>设置</h2></header><div class="demo-settings"><section><h3>连接</h3><div class="demo-setting-group"><div class="demo-setting-host"><span class="demo-connection-leading">${icon("desktop")}</span><span><strong>workstation</strong><small>局域网，${state.protocol==="ws"?"WebSocket":"QUIC"}，12 ms</small></span><span class="demo-connected"><i class="demo-dot"></i>已连接</span></div><button type="button" data-demo-action="protocol"><strong>连接协议</strong><span class="demo-protocol-value">${protocolName(state.protocol)}${icon("chevron-right")}</span></button></div></section><section><h3>外观</h3><div class="demo-appearance"><div class="demo-appearance-tiles" role="radiogroup" aria-label="浅色与深色">${[false,true].map(dark=>`<button type="button" class="demo-appearance-tile" role="radio" aria-checked="${pref.mode!=="system"&&pref.dark===dark}" data-demo-action="appearance-mode" data-value="${dark?"dark":"light"}"><span class="demo-preview-frame">${preview(theme(dark))}</span><span class="demo-appearance-name"><i class="demo-radio"></i>${dark?"深色":"浅色"}</span></button>`).join("")}</div><button type="button" class="demo-follow-row" data-demo-action="appearance-follow" role="radio" aria-checked="${pref.mode==="system"}">${icon("gear")}<span>跟随系统</span>${pref.mode==="system"?icon("check"):""}</button><div class="demo-material-row"><span>材质</span><div role="radiogroup" aria-label="材质">${[["mist","雾蓝"],["sage","灰绿"]].map(([id,name])=>`<button type="button" class="demo-material" role="radio" aria-checked="${pref.material===id}" data-demo-action="appearance-material" data-value="${id}"><span class="demo-material-frame"><i data-ob="${id==="sage"?"sage-":""}${pref.dark?"dark":"light"}"></i></span>${name}</button>`).join("")}</div></div></div></section><section><h3>语言</h3><div class="demo-setting-group"><button type="button" data-demo-action="language"><span><strong>${state.language==="system"?"跟随手机":state.language==="en"?"English":"简体中文"}</strong><small>${state.language==="en"?"English":"简体中文"}</small></span>${icon("chevron-right")}</button></div></section></div>${tabs("settings")}`;
  }
  function languageSheet() {
    return choiceSheet("语言","language",state.draftLanguage,[{id:"system",title:"跟随手机"},{id:"zh-Hans",title:"简体中文"},{id:"en",title:"English"}],state.draftLanguage===state.language?"正在使用":"应用语言",state.draftLanguage===state.language);
  }
  function directorySheet() {
    return `<div class="demo-modal-scrim" data-demo-action="directory-cancel"></div><section class="demo-protocol-sheet" role="dialog" aria-modal="true" aria-label="工作目录"><h2>工作目录</h2>${["/Projects/orbis","/Projects/website"].map(directory=>`<button type="button" class="demo-directory-choice" data-demo-action="directory-pick" data-directory="${directory}" aria-current="${state.directory===directory}"><span>${icon("folder")}</span><strong>${directory.split("/").pop()}<small>${directory}</small></strong>${icon("chevron-right")}</button>`).join("")}<button type="button" class="demo-sheet-cancel" data-demo-action="directory-cancel">取消</button></section>`;
  }
  function choiceSheet(title,key,value,options,label,disabled) {
    return `<div class="demo-modal-scrim" data-demo-action="${key}-cancel"></div><section class="demo-protocol-sheet" role="dialog" aria-modal="true" aria-label="${title}"><h2>${title}</h2><div role="radiogroup" aria-label="${title}">${options.map(option=>`<button type="button" class="demo-protocol-choice" role="radio" aria-checked="${value===option.id}" data-demo-action="${key}-choice" data-value="${option.id}"><i></i><span><strong>${option.title}</strong>${option.sub?`<small>${option.sub}</small>`:""}</span>${option.tag?`<small>${option.tag}</small>`:""}</button>`).join("")}</div><button type="button" class="demo-primary" data-demo-action="${key}-apply" ${disabled?"disabled":""}>${label}</button><button type="button" class="demo-sheet-cancel" data-demo-action="${key}-cancel">取消</button></section>`;
  }
  function downloads() {
    return `<header class="demo-topbar">${button("back-home","返回聊天列表","arrow-left")}<h2>下载</h2></header><p class="demo-empty">暂无下载</p>`;
  }
  function protocolSheet() {
    const options=[{id:"auto",title:"自动",tag:"推荐"},{id:"quic",title:"QUIC",info:true},{id:"ws",title:"WebSocket"}];
    return `<div class="demo-modal-scrim" data-demo-action="protocol-cancel"></div><section class="demo-protocol-sheet" role="dialog" aria-modal="true" aria-labelledby="demo-protocol-title"><h2 id="demo-protocol-title">连接协议</h2><div role="radiogroup" aria-label="连接协议">${options.map(option=>`<div class="demo-protocol-option"><button type="button" class="demo-protocol-choice" role="radio" aria-checked="${state.draftProtocol===option.id}" data-demo-action="protocol-choice" data-value="${option.id}"><i></i><span><strong>${option.title}</strong></span>${option.tag?`<small>${option.tag}</small>`:""}</button>${option.info?`<button type="button" class="demo-info" aria-label="查看 QUIC 说明" data-demo-action="protocol-info"><span aria-hidden="true">i</span></button>`:""}</div>`).join("")}</div><button type="button" class="demo-primary" data-demo-action="protocol-apply" ${state.draftProtocol===state.protocol?"disabled":""}>${state.draftProtocol===state.protocol?"当前使用":"切换到 "+protocolName(state.draftProtocol)+" 并重连"}</button><button type="button" class="demo-sheet-cancel" data-demo-action="protocol-cancel">取消</button></section>`;
  }
  function protocolInfo() {
    return `<div class="demo-info-scrim" data-demo-action="protocol-info-close"></div><section class="demo-dialog demo-info-dialog" role="dialog" aria-modal="true" aria-labelledby="demo-quic-title"><h2 id="demo-quic-title">QUIC</h2><p>当前网络不支持 QUIC 时无法连接</p><div><button type="button" class="demo-text-button primary" data-demo-action="protocol-info-close">知道了</button></div></section>`;
  }
  function chat() {
    const session=sessions.find(item=>item.id===state.session) || sessions[0];
    const agent=agents[session.agent];
    return `<header class="demo-topbar">${button("back-home","返回聊天列表","arrow-left")}<h2>${esc(session.title)}</h2>${button("downloads","下载","download")}</header><div class="demo-chat"><div class="demo-message-user">${esc(session.firstMessage||"首页下拉回弹有点卡，帮我看看")}</div><div class="demo-message-assistant"><strong class="agent-${agent.id}">${mark(agent)}${sessionAgentName(session)}</strong><p>收到。我会先查看相关实现，再逐项修改和验证。</p></div></div><div class="demo-chat-composer"><input aria-label="消息" placeholder="发给 ${sessionAgentName(session)}，/ 命令">${button("chat-send","发送","arrow-up")}</div>`;
  }
  function confirmation() {
    return `<div class="demo-modal-scrim"></div><section class="demo-dialog" role="dialog" aria-modal="true" aria-labelledby="demo-confirm-title"><h2 id="demo-confirm-title">${state.agent===0?(state.piEnabled.has(state.profile)?"从 Pi 移出 ":"为 Pi 启用 "):"切换 "+agents[state.agent].name+" 到 "}${profiles[state.profile]}？</h2><p>${state.agent===0?"Pi 配置将在当前电脑上启用或移出。":"已有会话需要重新打开。"}</p><div><button type="button" class="demo-text-button" data-demo-action="provider-cancel">取消</button><button type="button" class="demo-text-button primary" data-demo-action="provider-confirm">${state.agent===0?(state.piEnabled.has(state.profile)?"移出 Pi 配置":"启用 Pi 配置"):"切换并重载 Agent"}</button></div></section>`;
  }
  function notice(text) { state.notice=text; render(); }
  function toggleSelection(id) { if(state.selected.has(id))state.selected.delete(id);else state.selected.add(id); render(); }
  async function openDraft(directory=state.directory) {
    state.directory=directory; state.codexMenu=null; state.drawer=false; state.draft=true; state.page="home"; render();
    const draft=$(".demo-draft"), height=draft.offsetHeight;
    const material=window.getComputedStyle(root),inset=material.getPropertyValue("--inset-md"),raised=material.getPropertyValue("--raised-md");
    void motion(draft,[{boxShadow:inset},{boxShadow:inset,offset:.45},{boxShadow:raised}],460);
    for(const content of draft.children)void motion(content,[{opacity:0,transform:"translateY(4px)"},{opacity:0,offset:.3},{opacity:1,transform:"none"}],280);
    await motion(draft,[{height:"0px"},{height:`${height}px`}],260,"cubic-bezier(.4,0,.2,1)");
    $("#demo-first-message")?.focus({preventScroll:true});
  }
  async function closeDraft() {
    const draft=$(".demo-draft");
    if(draft)await motion(draft,[{height:`${draft.offsetHeight}px`,opacity:1},{height:"0px",opacity:0}],260,"cubic-bezier(.4,0,.2,1)");
    state.draft=false; state.codexMenu=null; render();
  }
  async function sendDraft() {
    if(!policy.canSend(state.text)||state.moving)return;
    const firstMessage=state.text.trim(), draft=$(".demo-draft"); state.moving=true;
    const rect=draft.getBoundingClientRect(), screenRect=root.getBoundingClientRect(), scale=screenRect.width/393;
    const cover=draft.cloneNode(true); cover.classList.add("demo-draft-morph"); root.append(cover);
    await motion(cover,[{left:`${(rect.left-screenRect.left)/scale}px`,top:`${(rect.top-screenRect.top)/scale}px`,width:`${rect.width/scale}px`,height:`${rect.height/scale}px`,borderRadius:"24px"},{left:"0px",top:"0px",width:"393px",height:"852px",borderRadius:"0px"}],320,"cubic-bezier(.32,.72,0,1)");
    if(disposed)return;
    const session={id:nextId++,title:firstMessage,directory:state.directory,agent:state.agent,codexVariant:state.agent===1?state.codexVariant:undefined,firstMessage};
    sessions.unshift(session); state.session=session.id; state.page="chat"; state.draft=false; state.text=""; state.moving=false; render();
    void motion($(".demo-message-user"),[{opacity:0,transform:"translateY(24px)"},{opacity:1,transform:"none"}],440);
  }
  function selectAgent(index) { const old=state.agent; state.agent=Math.max(0,Math.min(3,index)); state.profile=state.active[state.agent]; render(); if(old!==state.agent&&!state.moving)void motion($(".demo-dial-labels"),[{opacity:0},{opacity:1}],160); }
  function selectProfile(index) { const old=state.profile;state.profile=Math.max(0,Math.min(3,index)); render(); if(old!==state.profile&&!state.moving)void motion($(".demo-dial-labels"),[{transform:`translateY(${(state.profile-old)*96}px)`},{transform:"none"}],260); }
  function settleDial(layer,target) {
    window.cancelAnimationFrame(dialAnimation);
    const key=layer==="agent"?"dragAgent":"dragProfile",from=state[key]??(layer==="agent"?agentOrder.indexOf(state.agent):state.profile);
    state.moving=true;state[key]=from;
    if(layer==="agent")selectAgent(agentOrder[target]);else selectProfile(target);
    const ms=duration(220+Math.min(240,Math.abs(target-from)*90)),start=window.performance.now();
    const frame=now=>{if(disposed)return;const t=ms?Math.min(1,(now-start)/ms):1;state[key]=from+(target-from)*(1-Math.pow(1-t,3));layoutDial();if(t<1)dialAnimation=window.requestAnimationFrame(frame);else{delete state[key];state.moving=false;render();}};
    dialAnimation=window.requestAnimationFrame(frame);
  }
  function handleAction(action,target) {
    if(action==="draft-toggle") { if(state.draft)void closeDraft();else void openDraft(); return; }
    if(action==="codex-menu") {state.codexMenu=true;render();$('.demo-codex-menu [aria-checked="true"]')?.focus();return;}
    if(action==="codex-menu-close") {state.codexMenu=null;render();$(".demo-codex-trigger")?.focus();return;}
    if(action==="codex-variant") {state.codexVariant=target.dataset.value;state.codexMenu=null;render();$(".demo-codex-trigger")?.focus();return;}
    if(action==="draft-directory"){state.directorySheet=true;render();return;}
    if(action==="directory-pick"){state.directory=target.dataset.directory;state.directorySheet=false;render();return;}
    if(action==="directory-cancel"){state.directorySheet=false;render();return;}
    if(action==="appearance-mode"){appearance?.update({mode:target.dataset.value});render();return;}
    if(action==="appearance-material"){appearance?.update({material:target.dataset.value});render();return;}
    if(action==="appearance-follow"){appearance?.update({mode:"system"});render();return;}
    if(action==="language"){state.draftLanguage=state.language;state.languageSheet=true;render();return;}
    if(action==="language-choice"){state.draftLanguage=target.dataset.value;render();return;}
    if(action==="language-cancel"){state.languageSheet=false;render();return;}
    if(action==="language-apply"){state.language=state.draftLanguage;state.languageSheet=false;render();return;}
    if(action==="draft-agent") { state.agent=Number(target.dataset.index);state.codexMenu=null; render(); return; }
    if(action==="draft-send") { void sendDraft(); return; }
    if(action==="drawer-open") { state.drawer=true; render(); void motion($(".demo-drawer"),[{transform:"translateX(-320px)"},{transform:"none"}],320); return; }
    if(action==="drawer-close") { void motion($(".demo-drawer"),[{transform:"none"},{transform:"translateX(-320px)"}],180).then(()=>{state.drawer=false;render();});return; }
    if(action==="directory-toggle") { const dir=target.dataset.directory; if(state.expanded.has(dir))state.expanded.delete(dir);else state.expanded.add(dir); render(); return; }
    if(action==="directory-new") { void openDraft(target.dataset.directory); return; }
    if(action==="select-session") { toggleSelection(Number(target.dataset.id)); return; }
    if(action==="selection-cancel") { state.selected.clear();render();return; }
    if(action==="close-selected") { sessions=sessions.filter(session=>!state.selected.has(session.id));state.selected.clear();render();return; }
    if(action==="session-open") { state.session=Number(target.dataset.id);state.drawer=false;state.page="chat";render();return; }
    if(action==="tab") {const page=target.dataset.page;if(page===state.page)return;void motion($(".demo-content"),[{opacity:1},{opacity:0}],90,"cubic-bezier(.4,0,1,1)").then(()=>{state.page=page;state.drawer=false;render();void motion($(".demo-content"),[{opacity:0,transform:"translateY(8px)"},{opacity:1,transform:"none"}],210);});return;}
    if(action==="back-home") {state.page="home";render();return;}
    if(action==="dial-agent") { settleDial("agent",agentOrder.indexOf(Number(target.dataset.index))); return; }
    if(action==="dial-profile") { settleDial("profile",Number(target.dataset.index)); return; }
    if(action==="provider-apply"&&!state.moving) {state.dialog=true;render();$(".demo-dialog button")?.focus();return;}
    if(action==="provider-cancel") {state.dialog=false;render();$(".demo-apply")?.focus();return;}
    if(action==="provider-confirm") {if(state.agent===0){const active=state.piEnabled.has(state.profile);if(active)state.piEnabled.delete(state.profile);else state.piEnabled.add(state.profile);state.dialog=false;notice(`${active?"已移出":"已启用"} Pi 配置 ${profiles[state.profile]}`);}else{state.active[state.agent]=state.profile;state.dialog=false;notice(`已切换 ${agents[state.agent].name} 到 ${profiles[state.profile]}`);}return;}
    if(action==="quota-refresh") {notice("配额已更新");return;}
    if(action==="notice-close") {state.notice="";render();return;}
    if(action==="downloads") {state.page="downloads";render();return;}
    if(action==="protocol") {state.draftProtocol=state.protocol;state.protocolSheet=true;render();return;}
    if(action==="protocol-choice") {state.draftProtocol=target.dataset.value;render();return;}
    if(action==="protocol-info") {state.protocolInfo=true;render();$(".demo-info-dialog button")?.focus();return;}
    if(action==="protocol-info-close") {state.protocolInfo=false;render();$(".demo-info")?.focus();return;}
    if(action==="protocol-cancel") {state.protocolInfo=false;state.protocolSheet=false;render();return;}
    if(action==="protocol-apply") {state.protocol=state.draftProtocol;state.protocolSheet=false;notice("已应用连接协议，演示连接已恢复");return;}
    if(action==="chat-send") {const input=$(".demo-chat-composer input");if(input.value.trim()){notice("已发送");}return;}
  }
  root.addEventListener("click",event=>{
    if(suppressClick){suppressClick=false;return;}
    const target=event.target.closest("[data-demo-action]");
    if(target){if(target.disabled)return;handleAction(target.dataset.demoAction,target);return;}
    const card=event.target.closest("[data-session]");if(card){const id=Number(card.dataset.session);if(state.selected.size)toggleSelection(id);else{state.session=id;state.page="chat";render();}}
  });
  root.addEventListener("input",event=>{
    if(event.target.id==="demo-first-message"){state.text=event.target.value;$("[data-demo-action=draft-send]").disabled=!policy.canSend(state.text);}
    if(event.target.id==="demo-directory-search"){state.search=event.target.value;const position=event.target.selectionStart;render();const input=$("#demo-directory-search");input.focus();input.setSelectionRange(position,position);}
  });
  root.addEventListener("change",event=>{if(event.target.id==="demo-draft-directory")state.directory=event.target.value;});
  root.addEventListener("keydown",event=>{
    if(event.key==="Escape"){if(state.protocolInfo){handleAction("protocol-info-close",event.target);}else if(state.codexMenu){handleAction("codex-menu-close",event.target);}else if(state.languageSheet){state.languageSheet=false;render();}else if(state.directorySheet){state.directorySheet=false;render();}else if(state.protocolSheet){state.protocolSheet=false;render();}else if(state.dialog){state.dialog=false;render();}else if(state.drawer)handleAction("drawer-close",event.target);else if(state.draft)void closeDraft();else{state.page="home";render();}return;}
    if(state.codexMenu&&["ArrowUp","ArrowDown","Home","End","Tab"].includes(event.key)){const options=[...root.querySelectorAll(".demo-codex-menu button")];if(event.key==="Tab"){event.preventDefault();handleAction("codex-menu-close",event.target);return;}const index=options.indexOf(document.activeElement);event.preventDefault();options[event.key==="Home"?0:event.key==="End"?options.length-1:(index+(event.key==="ArrowUp"?-1:1)+options.length)%options.length]?.focus();return;}
    if(state.protocolInfo&&event.key==="Tab"){event.preventDefault();$(".demo-info-dialog button")?.focus();return;}
    if(state.dialog&&event.key==="Tab"){const buttons=[...root.querySelectorAll(".demo-dialog button")];const index=buttons.indexOf(document.activeElement);event.preventDefault();buttons[(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length].focus();return;}
    const slider=event.target.closest("[data-dial-layer]");
    if(slider&&["ArrowUp","ArrowDown","Home","End"].includes(event.key)){event.preventDefault();const agent=slider.dataset.dialLayer==="agent",current=agent?agentOrder.indexOf(state.agent):state.profile;const index=event.key==="Home"?0:event.key==="End"?3:current+(event.key==="ArrowDown"?1:-1);settleDial(agent?"agent":"profile",Math.max(0,Math.min(3,index)));root.querySelector(`[data-dial-layer=${agent?"agent":"profile"}]`).focus();return;}
    if(event.key==="Enter"&&event.target.id==="demo-first-message"&&!event.shiftKey){event.preventDefault();void sendDraft();return;}
    const card=event.target.closest("[data-session]");if(card&&(event.key==="Enter"||event.key===" ")){event.preventDefault();if(event.shiftKey||state.selected.size)toggleSelection(Number(card.dataset.session));else card.click();}
  });
  root.addEventListener("pointerdown",event=>{
    suppressClick=false;
    if(event.button!==0||event.target.closest("input,textarea,select"))return;
    const card=event.target.closest("[data-session]"),dial=event.target.closest(".demo-dial");
    if(!card&&!dial)return;
    if(event.target.closest("button")&&!dial)return;
    const bounds=root.getBoundingClientRect(),scale=bounds.width/393;
    const localX=(event.clientX-bounds.left)/scale;
    if(dial&&event.pointerType==="touch"&&localX<20)return;
    const dialBounds=dial?.getBoundingClientRect(),dialY=dial?(event.clientY-dialBounds.top)/scale:0;
    const layer=dial?policy.dialLayer(localX,dialY,event.pointerType==="touch",policy.dialGeometry(dial.clientWidth,dial.clientHeight)):null;
    if(dial&&!layer)return;
    if(dial){window.cancelAnimationFrame(dialAnimation);delete state.dragAgent;delete state.dragProfile;}
    gesture={lastY:event.clientY,lastTime:window.performance.now(),velocity:0,target:card||dial,card,layer,start:layer==="agent"?agentOrder.indexOf(state.agent):state.profile,feedbackSent:false,x:event.clientX,y:event.clientY,scale,id:event.pointerId,moved:false};
    if(card)selectionHold=window.setTimeout(()=>{if(gesture&&!gesture.moved){toggleSelection(Number(card.dataset.session));gesture=undefined;suppressClick=true;}},450);
  });
  root.addEventListener("pointermove",event=>{
    if(!gesture||gesture.id!==event.pointerId)return;
    const dx=(event.clientX-gesture.x)/gesture.scale,dy=(event.clientY-gesture.y)/gesture.scale;
    if(Math.hypot(dx,dy)>8)window.clearTimeout(selectionHold);
    if(gesture.card){if(!gesture.moved&&Math.abs(dy)>Math.abs(dx)&&Math.abs(dy)>8){gesture=undefined;return;}if(Math.abs(dx)<8&&!gesture.moved)return;gesture.moved=true;root.setPointerCapture(event.pointerId);gesture.target.style.transform=`translateX(${Math.min(0,dx)}px)`;const feedback=gesture.target.previousElementSibling,progress=Math.min(1,-dx/(gesture.target.offsetWidth*.4));feedback.dataset.armed=String(progress>=1);feedback.querySelector(".demo-swipe-label").textContent=policy.swipeArmed(-dx,gesture.target.offsetWidth)?"松手关闭":"关闭";feedback.querySelector("circle").style.strokeDashoffset=String(100*(1-progress));if(progress>=1&&!gesture.feedbackSent){gesture.feedbackSent=true;if(!reduced()){void motion(feedback.querySelector(".demo-swipe-seat"),[{transform:"scale(1)"},{transform:"scale(1.12)",offset:.5},{transform:"scale(1)"}],260);if(event.isTrusted){try{window.navigator.vibrate?.(12);}catch{/* Optional browser feedback never blocks the gesture. */}}}}}
    else {
      const threshold=gesture.layer==="agent"?10:4;if(Math.abs(dy)<threshold&&!gesture.moved)return;
      if(!gesture.moved){gesture.moved=true;gesture.y=event.clientY;gesture.lastY=event.clientY;gesture.lastTime=window.performance.now();root.setPointerCapture(event.pointerId);state.moving=true;}
      const distance=(event.clientY-gesture.y)/gesture.scale,position=gesture.start-distance/(gesture.layer==="agent"?84:96),clamped=Math.max(0,Math.min(3,position));
      const now=window.performance.now(),velocity=-(event.clientY-gesture.lastY)/gesture.scale/96/Math.max(1,now-gesture.lastTime);gesture.velocity=.7*gesture.velocity+.3*velocity;gesture.lastTime=now;gesture.lastY=event.clientY;
      if(gesture.layer==="agent"){
        const rounded=Math.round(clamped),d=clamped-rounded;state.dragAgent=rounded+Math.sign(d)*.5*Math.pow(Math.abs(d)*2,2.4);selectAgent(agentOrder[rounded]);
      }else{state.dragProfile=clamped;selectProfile(Math.round(clamped));}
      layoutDial();$(".demo-dial").dataset.grab=gesture.layer;$(".demo-apply").disabled=true;
    }
    event.preventDefault();
  },{passive:false});
  function finish(event){
    window.clearTimeout(selectionHold);if(!gesture||event.pointerId!==gesture.id)return;const old=gesture;gesture=undefined;
    if(old.moved){suppressClick=true;if(old.card){const dx=(event.clientX-old.x)/old.scale;if(event.type!=="pointercancel"&&policy.swipeArmed(-dx,old.target.offsetWidth)){const id=Number(old.card.dataset.session);void motion(old.target,[{transform:old.target.style.transform},{transform:"translateX(-430px)",opacity:0}],160).then(()=>{sessions=sessions.filter(session=>session.id!==id);render();});}else void motion(old.target,[{transform:old.target.style.transform},{transform:"none"}],320).then(render);}else{const position=state[old.layer==="agent"?"dragAgent":"dragProfile"]??old.start,target=event.type==="pointercancel"?old.start:policy.dialRelease(old.layer,position,window.performance.now()-old.lastTime>80?0:old.velocity);settleDial(old.layer,target);}}
  }
  root.addEventListener("pointerup",finish);root.addEventListener("pointercancel",finish);
  const unsubscribe=appearance?.subscribe(()=>{if(state.page==="settings")render();});
  screen.append(root); render();
  return {
    togglePlayback(){
      if(playing){stopPlayback();return;}
      stopPlayback();playing=true;onPlayback(true);
      const actions=scene==="create"?[
        ()=>openDraft(),()=>{state.text="检查并修复首页回弹，补齐测试";render();},()=>sendDraft(),
      ]:scene==="quota"?[()=>selectProfile(1),()=>{state.dialog=true;render();},()=>{state.active[state.agent]=state.profile;state.dialog=false;notice("已切换 Codex 到 relay-b");}]:[()=>{state.drawer=true;render();},()=>openDraft("/Projects/website"),()=>closeDraft()];
      actions.forEach((action,index)=>playback.push(window.setTimeout(()=>{if(!disposed)void action();},duration(600+index*1200))));
      playback.push(window.setTimeout(()=>{playing=false;onPlayback(false);},duration(4400)));
    },
    destroy(){disposed=true;window.cancelAnimationFrame(dialAnimation);unsubscribe?.();stopPlayback();window.clearTimeout(selectionHold);root.remove();},
  };
};
