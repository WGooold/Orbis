/* Live controls for the original film UI. All objects and results stay local to this demo. */
window.setupFilmDemo = function () {
  const gsap = window.gsap;
  const root = document.getElementById("feature-demo");
  const canvas = document.getElementById("film-canvas");
  const viewport = document.getElementById("film-viewport");
  const play = document.getElementById("demo-play");
  const tabs = [...root.querySelectorAll("[data-scene]")];
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => preference.matches;
  const $ = selector => canvas.querySelector(selector);
  const $$ = selector => [...canvas.querySelectorAll(selector)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const swipeCloseThreshold = 150;
  let film, scene = "chat", page = "chat", action, raf, last;
  let visible = true, paused = true, watching = false;
  let selected = new Set(), closed = new Set(), chosen = "claude", downloaded = new Set();
  let diffIndex = 0, queried = false, weekly = false, pairingDone = false;
  let gesture, hold, suppressClick = false, busy = false, downloadOrigin = "chat";
  let scrollBottom = 0;
  const agentKinds = {
    pi: ["Pi", "a-pi", "var(--pi)"], codex: ["Codex", "a-codexc", "var(--codex)"],
    desktop: ["Codex 桌面版", "a-codexc", "var(--codex)"], deepseek: ["DeepSeek", "a-dsh", "var(--dsh)"],
    claude: ["Claude Code", "a-claudecode", "var(--claude)"],
  };
  const ready = () => !paused && visible && !document.hidden && action;
  function state() {
    root.dataset.animating = String(Boolean(action));
    root.dataset.playing = String(Boolean(ready()));
    root.dataset.scene = scene;
    root.dataset.page = page;
    root.dataset.mode = watching ? "film" : "interactive";
    play.setAttribute("aria-label", paused ? "播放功能演示" : "暂停功能演示");
    play.querySelector(".play-icon").textContent = paused ? "▶" : "Ⅱ";
    play.querySelector(".play-label").textContent = paused ? "播放" : "暂停";
  }
  function schedule() {
    if (raf) window.cancelAnimationFrame(raf);
    raf = undefined; last = undefined;
    state();
    if (ready()) raf = window.requestAnimationFrame(tick);
  }
  function tick(now) {
    raf = undefined;
    if (!ready()) return;
    const a = action;
    a.time = Math.min(a.to, a.time + (last === undefined ? 0 : Math.min(80, now - last) / 1000));
    last = now;
    a.timeline.time(a.time, true);
    if (a.source) { if (!watching) frameForInteraction(); sourceState(a.time); }
    root.dataset.time = a.time.toFixed(3);
    if (a.time >= a.to) {
      action = undefined; paused = true; busy = false;
      if(a.source&&scene!=="pair")scrollBottom=film.layout.followAt(film.layout.finalBottom);
      a.done?.(); state(); return;
    }
    raf = window.requestAnimationFrame(tick);
  }
  function halt() {
    if (action && !action.source) action.timeline.kill();
    const shake=$("#s4-shake");
    if(shake)gsap.set(shake,{x:0});
    action = undefined; paused = true; busy = false;
    clearTimeout(hold); schedule();
  }
  function run(timeline, from, to, done, source = false) {
    halt();
    timeline.pause().time(from, true);
    if (source && !watching) frameForInteraction();
    action = { timeline, time: from, to, done, source };
    if (reduced()) {
      timeline.time(to, true);
      if (source) { frameForInteraction(); sourceState(to); }
      action = undefined; done?.(); state();
    } else { paused = false; schedule(); }
  }
  function animate(build, done) {
    halt(); watching = false;
    const tl = gsap.timeline({ paused: true });
    build(tl); run(tl, 0, tl.duration(), done);
  }
  function segment(from, to, done) { run(film.timeline, from, to, done, true); }
  function frameForInteraction() {
    if (scene === "pair") {
      gsap.set("#s2-cam", { x:0, y:0, z:0 });
      gsap.set("#s2-orbit", { rotationY:0, rotationX:0 });
      gsap.set("#s2-phone-pos", { y:0, rotationX:0 });
      gsap.set("#s2-phone-rot", { rotationY:360, rotationX:0 });
      gsap.set("#s2-laptop", { visibility:"hidden" });
    } else {
      gsap.set("#s4-zoom", { x:0, y:0, scale:1 });
      gsap.set("#s4-pos", { z:0 });
      gsap.set("#s4-rot", { rotationY:reduced()?0:-9, rotationX:reduced()?0:3 });
      gsap.set("#s4-touch", { opacity:0 });
    }
  }
  function size() {
    const width = viewport.clientWidth;
    const height = Math.min(800, Math.max(560, window.innerHeight - 155), (width - 16) * 2.12);
    viewport.style.height = `${height}px`;
    const scale = watching && scene === "pair" ? Math.min(width / 1920, height / 1080)
      : watching ? Math.min(width / 700, height / 1080)
      : Math.min((width - 24) / 450, height / 980);
    canvas.style.setProperty("--film-scale", String(scale));
  }
  function accessible() {
    if (scene === "pair") {
      for (const [selector, enabled] of [["#s2-sheet",page==="scanner"],["#s2-chat",page==="connected"]]) {
        const el = $(selector); el.inert = !enabled; el.setAttribute("aria-hidden",String(!enabled));
      }
      $("[data-action=scan]").tabIndex = page === "pair" ? 0 : -1;
      return;
    }
    for (const [id, name] of [["s4-home","home"],["s4-chat","chat"],["s4-diff","diff"],["s4-dl","downloads"],["s4-set","settings"],["s4-drawer","drawer"],["s4-new","create"]]) {
      const el = $(`#${id}`); el.inert = page !== name; el.setAttribute("aria-hidden",String(page!==name));
    }
    for (const card of $$(".scard")) {
      const hidden = closed.has(card.id) || Number(gsap.getProperty(card,"x")) < -392 || (card.id === "s4-cn" && Number(gsap.getProperty(card,"opacity")) < .1);
      card.inert = hidden; card.setAttribute("aria-hidden",String(hidden));
      card.setAttribute("aria-pressed",String(selected.has(card.id)));
    }
    for (const selector of ["#s4-ask","#s4-remind","#s4-jump","#s4-closeall"]) {
      const el = $(selector); const hidden = Number(gsap.getProperty(el,"opacity")) < .1;
      el.inert = hidden; el.setAttribute("aria-hidden",String(hidden));
    }
    for (const [i, el] of $$("#s4-pager .dpage").entries()) el.setAttribute("aria-hidden",String(i!==diffIndex));
    if (!watching && canvas.contains(document.activeElement) && document.activeElement.closest('[inert]')) {
      const focus = canvas.querySelector('[data-action]:not([inert])');
      const available = $$('[data-action]').find(el => !el.closest('[inert]'));
      (available || focus)?.focus({preventScroll:true});
    }
    state();
  }
  function sourceState(time) {
    if (scene === "pair") {
      page = time < 4.9 ? "pair" : time < 7.92 ? "scanner" : "connected";
    } else {
      const m=film.marks;
      page = time < 1.2 ? "home" : time < m.OPEN+.12 ? "chat"
        : time < m.BACK1+.46 ? "diff" : time < m.DL+.1 ? "chat"
        : time < m.EDGE+.92 ? "downloads" : time < m.HOME1+.46 ? "chat"
        : time < m.D+.1 ? "home" : time < m.NEW+.3 ? "drawer"
        : time < m.CREATE+.54 ? "create" : time < m.S+.1 ? "home"
        : time < m.OUT+.75 ? "settings" : "home";
      diffIndex = time >= m.FLIP+.3 ? 1 : 0;
    }
    accessible();
  }
  function control(el, actionName, label, data={}) {
    if (!el) return;
    el.setAttribute("role","button"); el.tabIndex=0;
    el.setAttribute("aria-label",label); el.dataset.action=actionName;
    Object.assign(el.dataset,data);
  }
  function decorate() {
    if (scene === "pair") {
      control($(".ext"),"scan","扫码配对演示");
      control($("#s2-sheet .round-btn"),"pair-reset","关闭扫码");
      control($("#s2-feed"),"scan-confirm","识别演示二维码");
      const note=document.createElement("p");note.className="film-pair-note";
      note.textContent="演示二维码 · 不连接真实电脑";$("#s2-sheet").append(note);
      const reset=document.createElement("button");reset.type="button";reset.className="film-pair-reset raised";
      reset.textContent="重新配对";reset.dataset.action="pair-reset";$("#s2-chat").append(reset);
      $("#s2-ptxt").textContent="演示配对完成";
      $(".d-exp").textContent="演示二维码";
      return;
    }
    const binds = [
      ["#s4-menu","menu","打开会话目录"],["#s4-dlhome","downloads","下载"],["#s4-gearbtn","settings","设置"],
      ["#s4-closeall","close-selected","关闭所选会话"],["#s4-chat > .rb","home","返回会话列表"],
      ["#s4-send","send","发送消息"],["#s4-input","type","输入示例消息"],["#s4-allow","allow","允许"],["#s4-deny","deny","拒绝"],
      ["#s4-remind","question","最近提问"],["#s4-jump","latest","回到最新"],
      ["#s4-diffrow","diff","查看本轮文件差异"],["#s4-dlbtn","downloads","下载列表"],
      ["#s4-diff > .rb","back-chat","返回对话"],["#s4-dl > .rb","back-download","返回"],
      ["#s4-set > .rb","home","返回会话列表"],["#s4-ccw","coin","查询配额"],
      ["#s4-drawer > .rb","drawer-close","关闭会话目录"],["#s4-newbtn","create-open","新建会话"],
      ["#s4-new > .rb","create-close","关闭新建会话"],["#s4-nc-pi","create-submit","创建会话"],
    ];
    for(const [selector,name,label] of binds) control($(selector),name,label);
    $("#s4-nc-claude").style.display="none";
    const rows=$$("#s4-dl > .raised").filter(el=>el.textContent.includes(".mov")||el.textContent.includes(".md"));
    rows.forEach((el,i)=>el.dataset.downloadFile=String(i));
    const empty=document.createElement("p");empty.id="film-download-empty";empty.textContent="暂无下载";$("#s4-dl").append(empty);
    for(const [i,el] of $$("#s4-new .nbtn").entries()) control(el,"choose-agent",["Pi","Codex","Codex 桌面版","DeepSeek","Claude Code"][i],{agent:["pi","codex","desktop","deepseek","claude"][i]});
    for(const [i,el] of $$("#s4-diff > .rb").entries()) if(i>0) control(el,i===1?"diff-prev":"diff-next",i===1?"上一个文件":"下一个文件");
    for(const [i,el] of [$("#s4-f0"),$("#s4-f1")].entries()) control(el,"download-file",i===0?"下载 refresh-demo.mov":"下载 release-notes.md",{file:String(i)});
    for(const card of $$(".scard")) control(card,"select-session",card.querySelector(".t").textContent,{card:card.id});
    const tests=$$("#s4-pager .dpage")[2];
    const code=document.createElement("div");code.className="film-test-diff inset";
    const lines=["@@ -0,0 +1,8 @@", "+ import Testing", "+ @testable import Orbis", "+", "+ @Test func measuresOnlyAtStart() {", "+   let pull = PullRefreshFixture()", "+   pull.begin(); pull.drag(to: 120)", "+   #expect(pull.measurements == 1)", "+ }"];
    lines.forEach((text,i)=>{const line=document.createElement("div");line.className=`dline ${i?'add':'hunk'}`;line.textContent=text;code.append(line);});tests.append(code);
    const count=document.createElement("span");count.id="film-pagecount";count.className="film-pagecount";$("#s4-diff").append(count);
    const hit=document.createElement("div");hit.className="film-diff-hit";$("#s4-diff").append(hit);
    $("#s4-diff > .rb").style.zIndex="3";
    const home=document.createElement("div");home.className="film-home-indicator";$("#s4-scr").append(home);
  }
  function mount(id, replaying = false) {
    halt(); gesture=undefined; selected=new Set(); closed=new Set(); downloaded=new Set();
    delete root.dataset.closed; delete root.dataset.lastClosed;
    chosen="claude"; queried=false; weekly=false; diffIndex=0; pairingDone=false; watching=replaying;
    film?.timeline.kill(); scene=id;
    canvas.innerHTML=window.OrbisFilmMarkup[id==="pair"?"s2":"s4"];
    film=(id==="pair"?window.createS2Film:window.createS4Film)();
    const m=film.marks;
    const start=replaying?0:id==="pair"?4.29:{chat:2.98,diff:m.OPEN+.8,download:m.BACK1+.6,sessions:m.L-.05,create:m.D-.05,quota:m.S+.55}[id];
    film.timeline.time(start,true);
    if(!replaying)frameForInteraction();
    decorate();
    if(id!=="pair"&&!replaying) {
      gsap.set("#s4-touch",{opacity:0});
      if(id==="create") {
        // Start with the complete list; the film enters here after closing three cards.
        gsap.set(".scard:not(#s4-cn)",{x:0,y:0,scale:1});
        gsap.set(".scard .sel",{clipPath:"circle(0px at 50% 50%)"});
        gsap.set("#s4-close",{opacity:0});
      }
      $("#film-pagecount").textContent="1 / 3";
      $("#s4-pg1").style.display="none";$("#s4-pg2").style.display="none";
      $("#s4-nc-pi").style.opacity="1";
      $("#s4-nc-pi").textContent="在这里新建 Claude Code 会话";
    }
    sourceState(start);
    if(id!=="pair"&&!replaying) {
      scrollBottom = Number(gsap.getProperty(film.layout.msgs,"y"));
      if(id==="download") {scrollBottom=film.layout.followAt(film.layout.finalBottom);gsap.set(film.layout.msgs,{y:scrollBottom});}
      updateDownloads();
    }
    tabs.forEach(tab=>{const on=tab.dataset.scene===id;tab.setAttribute("aria-selected",String(on));tab.tabIndex=on?0:-1;});
    viewport.setAttribute("aria-labelledby",`tab-${id}`);
    root.dataset.time=start.toFixed(3); state(); size();
  }
  function replay() {
    const id=scene; mount(id,true);
    const m=film.marks;
    const bounds=id==="pair"?[0,8.05]:{
      chat:[0,m.OPEN-.1],diff:[m.OPEN-.2,m.BACK1+.65],download:[m.FLY1-.2,m.HOME1+.8],
      sessions:[m.L-.1,m.D-.1],create:[m.D-.1,m.S-.1],quota:[m.S-.1,m.OUT+.6],
    }[id];
    if(id!=="pair") {
      $("#s4-nc-claude").style.display="";$("#s4-nc-pi").textContent="在这里新建 Pi 会话";
      $("#s4-pg1").style.display="";$("#s4-pg2").style.display="";$("#film-pagecount").hidden=true;
      $$("[data-download-file]").forEach(el=>el.hidden=false);$("#film-download-empty").hidden=true;
    }
    size();segment(...bounds,()=>mount(id));
  }
  function pageTo(next) {
    halt(); watching=false;frameForInteraction();
    const current=page;
    const ids={chat:"#s4-chat",diff:"#s4-diff",downloads:"#s4-dl",settings:"#s4-set"};
    const to=ids[next], from=ids[current];
    page=next;
    animate(tl=>{
      if(next==="home") {
        if(from) tl.to(from,{x:393,duration:.36,ease:"power3.inOut"},0);
        tl.to("#s4-home",{x:0,duration:.36,ease:"power3.inOut"},0);
        tl.to("#s4-homedim",{opacity:0,duration:.36},0);
      } else if(next==="chat"&&(current==="diff"||current==="downloads")) {
        tl.to(from,{x:393,duration:.36,ease:"power3.inOut"},0);
        tl.to(to,{x:0,duration:.36,ease:"power3.inOut"},0);
      } else {
        // Manual pushes must retain the film's page stack, below its modal layers.
        const under=from||"#s4-home";
        const zIndex=Math.max(10,(Number(gsap.getProperty(under,"zIndex"))||0)+1);
        gsap.set(to,{zIndex,x:393,scale:1,borderRadius:0});
        tl.to(to,{x:0,duration:.42,ease:"expo.out"},0);
        tl.to(under,{x:-393*.3,duration:.42,ease:"expo.out"},0);
      }
    },accessible);
    accessible();
  }
  function changeFile(delta) {
    diffIndex=(diffIndex+delta+3)%3;
    animate(tl=>tl.to("#s4-pager",{x:-393*diffIndex,duration:.5,ease:"power3.inOut"}));
    $("#film-pagecount").textContent=`${diffIndex+1} / 3`; accessible();
  }
  function updateDownloads() {
    if(scene==="pair")return;
    let row=0;
    for(const el of $$("[data-download-file]")) {
      el.hidden=!downloaded.has(Number(el.dataset.downloadFile));
      if(!el.hidden)el.style.top=`${280+94*row++}px`;
    }
    $("#film-download-empty").hidden=downloaded.size>0;
    gsap.set("#s4-d0a",{opacity:0});gsap.set(["#s4-d0b","#s4-dl0bar"],{opacity:1,scaleX:1});
  }
  function fileFlight(index) {
    halt();watching=false;frameForInteraction();
    const row=$(`#s4-f${index}`), layout=film.layout;
    const from={x:16+row.offsetLeft+92,y:layout.off(row)+row.offsetHeight/2+124+Number(gsap.getProperty(layout.msgs,"y"))};
    const to={x:350,y:84}; const top=Math.min(from.y,to.y); const c={x:(from.x+to.x)/2,y:top-Math.min(120,top/2)};
    const frames=Array.from({length:12},(_,i)=>{const t=(i+1)/12,s=t*t*(3-2*t),u=1-s;return{x:u*u*from.x+2*u*s*c.x+s*s*to.x,y:u*u*from.y+2*u*s*c.y+s*s*to.y,scale:(28-12*s)/28,opacity:t<.846?1:(1-t)/.154};});
    downloaded.add(index); updateDownloads();
    animate(tl=>{
      tl.set("#s4-fly",{...from,opacity:1,scale:1},0);
      tl.to(row,{scale:.98,duration:.08,ease:"power2.out"},0).to(row,{scale:1,duration:.22,ease:"power2.out"},.08);
      tl.to("#s4-fly",{keyframes:frames,duration:.52,ease:"none"},0);
      tl.to("#s4-dlglyph",{y:4,duration:.09,ease:"power2.out"},.5).to("#s4-dlglyph",{y:0,duration:.22,ease:"back.out(3)"},.59);
      tl.to("#s4-dlbtn",{scale:.88,duration:.09},.5).to("#s4-dlbtn",{scale:1,duration:.22,ease:"back.out(2.5)"},.59);
      tl.fromTo("#s4-dlbadge",{opacity:0,scale:.4},{opacity:1,scale:1,duration:.25,ease:"back.out(2.6)"},.52);
    },()=>{$("#s4-bd1").textContent=String(downloaded.size);gsap.set("#s4-bd1",{opacity:1});gsap.set("#s4-bd2",{opacity:0});});
  }
  function toolbar(tl) {
    const on=selected.size>0;
    tl.to("#s4-b1",{y:on?6:0,rotation:on?45:0,duration:.26,ease:"power2.inOut"},0);
    tl.to("#s4-b3",{y:on?-6:0,rotation:on?-45:0,duration:.26,ease:"power2.inOut"},0);
    tl.to("#s4-b2",{scaleX:on?0:1,opacity:on?0:1,duration:.16},0);
    tl.to("#s4-brand",{opacity:on?0:1,duration:.14},0);
    tl.to("#s4-seltitle",{opacity:on?1:0,duration:.16},.1);
    tl.to("#s4-dlhome",{x:on?24:0,opacity:on?0:1,duration:.16},0);
    tl.to("#s4-gearbtn",{x:on?-24:0,opacity:on?0:1,duration:.16},0);
    tl.to("#s4-closeall",{opacity:on?1:0,scale:1,duration:.1},.16);
    tl.to(".scard .ind",{opacity:on?1:0,duration:.2},0);
    $("#s4-seltitle").textContent=`已选择 ${selected.size} 项`;
    $("#s4-menu").setAttribute("aria-label",on?"取消选择":"打开会话目录");
  }
  function toggleCard(card,event) {
    halt();watching=false;frameForInteraction();
    const id=card.id,on=!selected.has(id);if(on) selected.add(id);else selected.delete(id);
    const rect=card.getBoundingClientRect();
    const x=event?.clientX?clamp((event.clientX-rect.left)/rect.width*357,0,357):178;
    const y=event?.clientY?clamp((event.clientY-rect.top)/rect.height*96,0,96):48;
    animate(tl=>{
      if(on)tl.fromTo(card.querySelector(".sel"),{clipPath:`circle(0px at ${x}px ${y}px)`},{clipPath:`circle(380px at ${x}px ${y}px)`,duration:.26,ease:"power2.out"},0);
      else tl.to(card.querySelector(".sel"),{clipPath:`circle(0px at ${x}px ${y}px)`,duration:.26,ease:"power2.out"},0);
      tl.to(card.querySelector(".ind b"),{opacity:on?1:0,duration:.18},.05);toolbar(tl);
    },accessible);accessible();
  }
  function closeCards(ids) {
    if(!ids.length) return;
    const previously=[...closed]; ids.forEach(id=>{closed.add(id);selected.delete(id);});
    animate(tl=>{
      ids.forEach((id,i)=>tl.to(`#${id}`,{x:-430,duration:.18,ease:"power2.in"},i*.06));
      let n=0;
      for(const card of $$(".scard:not(#s4-cn)")) {
        if(closed.has(card.id))continue;
        tl.to(card,{y:180+n++*110-card.offsetTop,duration:.2,ease:"power2.out"},.18+(ids.length-1)*.06);
      }
      toolbar(tl);tl.set("#s4-close",{opacity:0},.18);
    },accessible);
    root.dataset.closed=[...closed].join(",");root.dataset.lastClosed=ids.filter(id=>!previously.includes(id)).join(",");accessible();
  }
  function swipeFeedback(event) {
    if(gesture.feedbackSent)return;
    gesture.feedbackSent=true;
    if(reduced())return;
    animate(tl=>window.addFilmShake(tl));
    if(event.isTrusted) {
      // Optional hardware feedback; unsupported or denied vibration is harmless.
      try { navigator.vibrate?.(12); } catch { /* Keep the visual feedback. */ }
    }
  }
  function drawer(open) {
    page=open?"drawer":"home";
    animate(tl=>{tl.to("#s4-drawer",{x:open?0:-350,duration:.4,ease:"expo.out"},0);tl.to("#s4-scrim",{opacity:open?.28:0,duration:.3},0);},accessible);accessible();
  }
  function newSheet(open) {
    page=open?"create":"home";
    gsap.set("#s4-new",{zIndex:40});
    animate(tl=>{tl.to("#s4-drawer",{x:-350,duration:.3,ease:"power2.in"},0);tl.to("#s4-scrim",{opacity:open?.22:0,duration:.3},0);tl.to("#s4-new",{y:open?0:852,duration:open?.45:.36,ease:open?"expo.out":"power2.in"},open?.15:0);},accessible);
    chooseAgent(chosen);accessible();
  }
  function chooseAgent(kind) {
    chosen=kind;
    for(const el of $$("#s4-new .nbtn")) {
      const on=el.dataset.agent===kind;
      el.setAttribute("aria-pressed",String(on));gsap.set(el.querySelector(".sel"),{opacity:on?1:0});gsap.set(el.querySelector(".ico"),{opacity:on?1:0});
    }
    const [name,,color]=agentKinds[kind];const submit=$("#s4-nc-pi");submit.textContent=`在这里新建 ${name} 会话`;submit.style.color=color;
  }
  function createSession() {
    if(busy)return;
    const [name,icon,color]=agentKinds[chosen], card=$("#s4-cn");
    card.querySelector(".agent").className=`agent ${icon}`;card.querySelector(".card-agent").textContent=name;card.querySelector(".card-agent").style.color=color;
    gsap.set(card.querySelector(".st-a"),{opacity:1});gsap.set(card.querySelector(".st-b"),{opacity:0});
    card.setAttribute("aria-label",`新会话，${name}`);page="home";
    animate(tl=>{
      tl.to("#s4-new",{y:852,duration:.36,ease:"power2.in"},.18);tl.to("#s4-scrim",{opacity:0,duration:.3},.2);
      let n=1;for(const existing of $$(".scard:not(#s4-cn)")) if(!closed.has(existing.id))tl.to(existing,{y:180+n++*110-existing.offsetTop,duration:.4,ease:"power2.inOut"},.58);
      tl.set(card,{opacity:1,zIndex:40,y:720,scale:1.05,boxShadow:"10px 22px 34px rgba(42,51,68,.24),-4px -4px 9px rgba(255,255,255,.9)"},.68);
      tl.to(card,{y:-10,scale:1.04,duration:.72,ease:"power2.out"},.68);
      tl.to(card,{y:0,scale:1,boxShadow:"4px 4px 9px rgba(166,178,198,.62),-4px -4px 9px rgba(255,255,255,.9)",duration:.3,ease:"power2.inOut"},1.4);
      tl.set(card.querySelector(".st-a"),{opacity:0},2.08);tl.set(card.querySelector(".st-b"),{opacity:1},2.08);
    },()=>{busy=false;accessible();});busy=Boolean(action);accessible();
  }
  function coin() {
    if(busy)return;
    if(!queried) {
      watching=false; segment(film.marks.Q,film.marks.READ+.75,()=>{queried=true;page="settings";$("#s4-ccw").setAttribute("aria-label","5 小时剩余 72%，查看本周配额");accessible();});busy=Boolean(action);return;
    }
    const from=Number(gsap.getProperty("#s4-coin","--a"))||0;
    weekly=!weekly;
    const old=weekly?["#s4-l5h","#s4-v72"]:["#s4-lwk","#s4-v41"];
    const next=weekly?["#s4-lwk","#s4-v41"]:["#s4-l5h","#s4-v72"];
    animate(tl=>{
      tl.to("#s4-coin",{"--a":from+90,duration:.22,ease:"power2.in"},0).to("#s4-coin",{"--a":from+180,duration:.34,ease:"power3.out"},.22);
      tl.to("#s4-cshadow",{scaleX:.35,opacity:.5,duration:.22,ease:"power2.in"},0).to("#s4-cshadow",{scaleX:1,opacity:1,duration:.34,ease:"power3.out"},.22);
      tl.fromTo(["#s4-sheen1","#s4-sheen2"],{backgroundPosition:"100% 0"},{backgroundPosition:"0% 0",duration:.56,ease:"power2.inOut"},0);
      tl.to(old,{y:-16,opacity:0,duration:.16,ease:"power2.in"},.12);tl.fromTo(next,{y:16,opacity:0},{y:0,opacity:1,duration:.24,ease:"power2.out"},.24);
    },()=>{busy=false;});busy=Boolean(action);
    $("#s4-ccw").setAttribute("aria-label",weekly?"本周剩余 41%，查看 5 小时配额":"5 小时剩余 72%，查看本周配额");
  }
  function scan() {
    if(pairingDone) {mount("pair");return;}
    watching=false;segment(4.3,8.05,()=>{pairingDone=true;page="connected";accessible();});
  }
  function click(event) {
    if(suppressClick){suppressClick=false;return;}
    const target=event.target.closest("[data-action]");if(!target||target.closest("[inert]"))return;
    if(watching){mount(scene);return;}
    const name=target.dataset.action,m=film.marks;
    if(name==="send"||name==="type") {segment(name==="type"?1.95:2.98,m.ASK+.32,()=>{page="chat";accessible();});return;}
    if(name==="allow") {segment(m.ALLOW,m.UP+1.12,()=>{page="chat";accessible();});return;}
    if(name==="deny") {
      animate(tl=>{tl.to("#s4-ask",{opacity:0,y:film.layout.askTop+8,duration:.16,ease:"power1.in"});tl.set("#s4-askst",{opacity:1},.16);});
      $("#s4-askst span").textContent="已拒绝";gsap.set("#s4-askspin",{opacity:0});$("#s4-ask").inert=true;return;
    }
    if(name==="question") {segment(m.TAPQ,m.TAPQ+.75);return;}
    if(name==="latest") {segment(m.JUMP,m.JUMP+.72);return;}
    if(name==="home") {pageTo("home");return;}
    if(name==="diff") {pageTo("diff");return;}
    if(name==="back-chat") {pageTo("chat");return;}
    if(name==="back-download") {pageTo(downloadOrigin);return;}
    if(name==="downloads") {
      downloadOrigin=page;updateDownloads();pageTo("downloads");return;
    }
    if(name==="settings") {pageTo("settings");return;}
    if(name==="diff-next"||name==="diff-prev") {changeFile(name==="diff-next"?1:-1);return;}
    if(name==="download-file") {fileFlight(Number(target.dataset.file));return;}
    if(name==="select-session") {toggleCard(target,event);return;}
    if(name==="close-selected") {closeCards([...selected]);return;}
    if(name==="menu") {
      if(selected.size) {const old=[...selected];selected.clear();animate(tl=>{for(const id of old){tl.to(`#${id} .sel`,{clipPath:"circle(0px at 50% 50%)",duration:.26},0);tl.to(`#${id} .ind b`,{opacity:0,duration:.18},0);}toolbar(tl);},accessible);}else drawer(true);return;
    }
    if(name==="drawer-close") {drawer(false);return;}
    if(name==="create-open") {newSheet(true);return;}
    if(name==="create-close") {newSheet(false);return;}
    if(name==="choose-agent") {chooseAgent(target.dataset.agent);return;}
    if(name==="create-submit") {createSession();return;}
    if(name==="coin") {coin();return;}
    if(name==="scan"||name==="scan-confirm") {scan();return;}
    if(name==="pair-reset") mount("pair");
  }
  function scrollChat(delta) {
    if(page!=="chat"||watching)return false;
    const current=Number(gsap.getProperty(film.layout.msgs,"y"));
    const next=clamp(current-delta,scrollBottom,0);
    if(next===current)return false;
    halt();gsap.set(film.layout.msgs,{y:next});
    const up=next>scrollBottom+40;
    gsap.set("#s4-remind",{opacity:up?1:0,y:up?0:-8});gsap.set("#s4-jump",{opacity:up?1:0,scale:up?1:.8});
    accessible();return true;
  }
  canvas.addEventListener("wheel",event=>{
    if(event.target.closest("#s4-view")&&scrollChat(event.deltaY))event.preventDefault();
  },{passive:false});
  let touchScroll;
  canvas.addEventListener("touchstart",event=>{
    if(page==="chat"&&!watching&&event.target.closest("#s4-view"))touchScroll=event.touches[0].clientY;
  },{passive:true});
  canvas.addEventListener("touchmove",event=>{
    if(touchScroll===undefined)return;
    const y=event.touches[0].clientY,delta=(touchScroll-y)/Number(canvas.style.getPropertyValue("--film-scale"));touchScroll=y;
    if(scrollChat(delta))event.preventDefault();
  },{passive:false});
  canvas.addEventListener("touchend",()=>{touchScroll=undefined;},{passive:true});
  canvas.addEventListener("click",click);
  canvas.addEventListener("keydown",event=>{
    if(event.key==="Escape") {if(page==="drawer")drawer(false);else if(page==="create")newSheet(false);else if(page==="diff"||page==="downloads")pageTo(page==="downloads"?downloadOrigin:"chat");else if(scene==="pair")mount("pair");return;}
    if(page==="diff"&&(event.key==="ArrowLeft"||event.key==="ArrowRight")){event.preventDefault();changeFile(event.key==="ArrowRight"?1:-1);return;}
    if((event.key==="Enter"||event.key===" ")&&event.target.matches('[role="button"]')){event.preventDefault();event.target.click();}
  });
  canvas.addEventListener("pointerdown",event=>{
    suppressClick=false;
    if(event.button!==0||watching)return;
    const card=event.target.closest(".scard"), diff=event.target.closest(".film-diff-hit");
    const screen=$("#s4-scr");if(!screen)return;
    const rect=screen.getBoundingClientRect();const edge=(page==="diff"||page==="downloads"||page==="chat")&&event.clientX-rect.left<rect.width*.08;
    if(!card&&!diff&&!edge)return;
    suppressClick=false;
    gesture={x:event.clientX,y:event.clientY,id:event.pointerId,card,diff,edge,active:false,scale:rect.width/393,target:event.target};
    if(card)hold=setTimeout(()=>{if(gesture&&!gesture.active){toggleCard(card,event);suppressClick=true;gesture=undefined;}},450);
  });
  canvas.addEventListener("pointermove",event=>{
    if(!gesture||gesture.id!==event.pointerId)return;
    const dx=(event.clientX-gesture.x)/gesture.scale,dy=(event.clientY-gesture.y)/gesture.scale;
    if(Math.hypot(dx,dy)>8)clearTimeout(hold);
    if(!gesture.active&&Math.abs(dy)>Math.abs(dx)&&Math.abs(dy)>8){gesture=undefined;return;}
    if(Math.abs(dx)<8&&!gesture.active)return;
    if(!gesture.active){halt();gesture.active=true;gesture.target.setPointerCapture(event.pointerId);}
    event.preventDefault();
    if(gesture.card){
      const armed=dx< -swipeCloseThreshold;
      gsap.set(gesture.card,{x:clamp(dx,-430,0)});
      gsap.set("#s4-close",{opacity:1,top:gesture.card.offsetTop+Number(gsap.getProperty(gesture.card,"y"))});
      gsap.set("#s4-close-r",{opacity:armed?0:1});gsap.set("#s4-close-g",{opacity:armed?1:0});
      if(armed)swipeFeedback(event);
    }
    else if(gesture.edge){const id=page==="diff"?"#s4-diff":page==="downloads"?"#s4-dl":"#s4-chat";gsap.set(id,{x:clamp(dx,0,423),scale:1-.04*clamp(dx/156,0,1),borderRadius:24*clamp(dx/156,0,1)});gsap.set(page==="chat"||(page==="downloads"&&downloadOrigin==="home")?"#s4-home":"#s4-chat",{x:-117.9+clamp(dx,0,393)*.3});}
    else gsap.set("#s4-pager",{x:-393*diffIndex+dx});
  },{passive:false});
  function finish(event) {
    clearTimeout(hold);if(!gesture||gesture.id!==event.pointerId)return;
    const g=gesture;gesture=undefined;if(!g.active)return;
    suppressClick=true;
    const dx=(event.clientX-g.x)/g.scale,cancel=event.type==="pointercancel";
    if(g.card){if(!cancel&&dx< -swipeCloseThreshold)closeCards([g.card.id]);else animate(tl=>{tl.to(g.card,{x:0,duration:.3,ease:"power2.out"});tl.set("#s4-close",{opacity:0});});}
    else if(g.edge){
      const id=page==="diff"?"#s4-diff":page==="downloads"?"#s4-dl":"#s4-chat",back=page==="chat"?"home":page==="downloads"?downloadOrigin:"chat",under=back==="home"?"#s4-home":"#s4-chat";
      const complete=!cancel&&dx>110;if(complete)page=back;
      animate(tl=>{tl.to(id,{x:complete?423:0,scale:complete?.96:1,borderRadius:complete?24:0,duration:complete?.18:.3,ease:complete?"power2.in":"power2.out"},0);tl.to(under,{x:complete?0:-117.9,duration:.3,ease:"power2.out"},0);},accessible);accessible();
    }else{const delta=!cancel&&Math.abs(dx)>60?(dx<0?1:-1):0;changeFile(delta);}
  }
  window.addEventListener("pointerup",finish);window.addEventListener("pointercancel",finish);
  tabs.forEach(tab=>tab.addEventListener("click",()=>mount(tab.dataset.scene)));
  root.querySelector(".chapter-tabs").addEventListener("keydown",event=>{
    let i=tabs.findIndex(tab=>tab.dataset.scene===scene);
    if(event.key==="ArrowRight")i=(i+1)%tabs.length;else if(event.key==="ArrowLeft")i=(i+tabs.length-1)%tabs.length;else if(event.key==="Home")i=0;else if(event.key==="End")i=tabs.length-1;else return;
    event.preventDefault();tabs[i].focus();mount(tabs[i].dataset.scene);
  });
  play.addEventListener("click",()=>{if(action){paused=!paused;schedule();}else replay();});
  document.getElementById("demo-replay").addEventListener("click",()=>mount(scene));
  document.addEventListener("visibilitychange",schedule);
  if("IntersectionObserver" in window)new window.IntersectionObserver(entries=>{visible=entries[0].isIntersecting;schedule();},{threshold:.08}).observe(viewport);
  window.addEventListener("resize",size);
  preference.addEventListener("change",()=>{if(reduced())mount(scene);});
  mount("chat");
};
