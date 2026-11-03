/* Web adaptation of ../video/claude/compositions/s3-agents.html and s4-features.html.
 * The film supplies the geometry, artwork, example conversations and motion language.
 * These are isolated demonstrations: no Agent or Host commands are sent. */
const motionPreference = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
const reducedMotion = () => motionPreference?.matches ?? false;
const byId = id => document.getElementById(id);
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

const agents = [
  { name: "Claude Code", image: "lobe-claudecode-color" },
  { name: "Codex", image: "lobe-codex-color" },
  { name: "Pi", image: "pi" },
  { name: "Codex Desktop", image: "lobe-codex-color" },
  { name: "DeepSeek", image: "deepseek" },
  { name: "ZCode", image: "lobe-zai", preview: true },
  { name: "OpenCode", image: "lobe-opencode", preview: true },
  { name: "Kimi Code", image: "lobe-kimi-color", preview: true },
  { name: "Oh My Pi", image: "omp-icon", preview: true },
  { name: "Hermes", image: "lobe-hermesagent", preview: true },
  { name: "OpenClaw", image: "lobe-openclaw-color", preview: true },
];

function setupOrbit() {
  const gsap=window.gsap, stage=byId("orbit-stage"), root=byId("agents"), picks=byId("agent-picks"), toggle=byId("orbit-play");
  const canvas=document.createElement("div");canvas.id="orbit-canvas";canvas.innerHTML=window.OrbisFilmMarkup.s3;
  stage.replaceChildren(canvas);
  let film=window.createS3Film(), ring=byId("s3-ring"), cards=[...ring.children];
  const step=film.step;
  let position=0, drag, suppressClick=false, time=0, animation, request, previous;
  let visible=true, paused=true, mode="interactive";
  const normalized=n=>((n%agents.length)+agents.length)%agents.length;
  for(const [index,agent] of agents.entries()) {
    const pick=document.createElement("button");pick.type="button";pick.className="agent-pick";
    pick.dataset.preview=String(Boolean(agent.preview));pick.title=agent.name;
    pick.setAttribute("aria-label",`${agent.name}，${agent.preview?"即将接入":"已接入"}`);
    pick.innerHTML=agentImage(agent.image);pick.addEventListener("click",()=>selectNearest(index));picks.append(pick);
  }
  const buttons=[...picks.children];
  function decorateCards() {
    for(const [index,agent] of agents.entries()) {
      cards[index].dataset.agentIndex=String(index);cards[index].setAttribute("aria-hidden","true");
      if(agent.preview){cards[index].classList.add("film-preview-agent");cards[index].querySelector(".c-status").textContent="即将接入";}
    }
  }
  function rebuild() {
    film.timeline.kill();canvas.innerHTML=window.OrbisFilmMarkup.s3;
    film=window.createS3Film();ring=byId("s3-ring");cards=[...ring.children];decorateCards();
  }
  decorateCards();
  function label(value) {
    const index=normalized(Math.round(value)),agent=agents[index];
    root.dataset.selected=String(index);
    byId("agent-name").textContent=agent.name;byId("agent-availability").textContent=agent.preview?"即将接入":"已接入";
    byId("agent-name").parentElement.classList.toggle("is-preview",Boolean(agent.preview));
    buttons.forEach((button,i)=>button.setAttribute("aria-pressed",String(i===index)));
  }
  function size() {
    const height=stage.clientHeight,width=stage.clientWidth;
    const scale=mode==="film"?Math.min(width/1920,height/1080):Math.min(width/520,height/1000);
    canvas.style.setProperty("--orbit-scale",String(scale));
  }
  function interactive() {
    mode="interactive";film.timeline.time(6.2,true);
    gsap.set("#s3-world",{scale:1,opacity:1,filter:"none"});gsap.set("#s3-mon",{opacity:0});
    gsap.set("#s3-stage",{perspectiveOrigin:"960px 540px"});
    gsap.set("#s3-car",{x:-460,y:-40,scale:.88,rotationX:-10});
    gsap.set("#s3-label,#s3-claim",{opacity:0});
    cards.forEach((card,i)=>gsap.set(card.querySelectorAll(".cf"),{filter:i===normalized(position)?"none":"blur(3px)"}));
    gsap.set(ring,{rotationY:-position*step});size();
  }
  function schedule() {
    if(request)window.cancelAnimationFrame(request);request=undefined;previous=undefined;
    const running=Boolean(animation&&!paused&&visible&&!document.hidden);
    root.dataset.playing=String(running);root.dataset.mode=mode;
    toggle.setAttribute("aria-label",paused?"播放 Agent 旋转演示":"暂停 Agent 旋转演示");
    toggle.querySelector(".play-icon").textContent=paused?"▶":"Ⅱ";toggle.querySelector(".play-label").textContent=paused?"播放旋转":"暂停旋转";
    if(running)request=window.requestAnimationFrame(tick);
  }
  function tick(now) {
    request=undefined;
    time=Math.min(animation.to,time+(previous===undefined?0:Math.min(80,now-previous)/1000));previous=now;
    animation.timeline.time(time,true);
    if(mode==="film")label(-Number(gsap.getProperty(ring,"rotationY"))/step);
    root.dataset.time=time.toFixed(3);
    if(time>=animation.to){animation=undefined;paused=true;if(mode==="film"){position=0;interactive();label(0);}schedule();return;}
    request=window.requestAnimationFrame(tick);
  }
  function stop() {if(animation&&mode!=="film")animation.timeline.kill();animation=undefined;paused=true;schedule();}
  function select(next) {
    const angle=mode==="film"?-Number(gsap.getProperty(ring,"rotationY"))/step:position;
    if(mode==="film")position=Math.round(angle);
    stop();if(mode==="film")interactive();
    position=next;label(position);
    byId("agent-announcement").textContent=`${agents[normalized(position)].name}，${agents[normalized(position)].preview?"即将接入":"已接入"}`;
    const tl=gsap.timeline({paused:true});
    tl.to(ring,{rotationY:-position*step,duration:1.15,ease:"expo.out"},0);
    cards.forEach((card,i)=>tl.to(card.querySelectorAll(".cf"),{filter:i===normalized(position)?"blur(0px)":"blur(3px)",duration:.32},0));
    if(reducedMotion())tl.time(tl.duration(),true);else{animation={timeline:tl,to:tl.duration()};time=0;paused=false;schedule();}
  }
  function selectNearest(index) {
    const current=-Number(gsap.getProperty(ring,"rotationY"))/step;
    let delta=normalized(index-normalized(Math.round(current)));if(delta>agents.length/2)delta-=agents.length;
    select(Math.round(current)+delta);
  }
  toggle.addEventListener("click",()=>{
    if(animation){paused=!paused;schedule();return;}
    if(reducedMotion()){select(position+1);return;}
    rebuild();mode="film";film.timeline.time(0,true);size();animation={timeline:film.timeline,to:15.8};time=0;paused=false;schedule();
  });
  byId("agent-prev").addEventListener("click",()=>select(position-1));byId("agent-next").addEventListener("click",()=>select(position+1));
  picks.addEventListener("keydown",event=>{
    const focused=buttons.indexOf(document.activeElement);if(focused<0)return;
    const target=event.key==="ArrowRight"?normalized(focused+1):event.key==="ArrowLeft"?normalized(focused-1):event.key==="Home"?0:event.key==="End"?agents.length-1:undefined;
    if(target===undefined)return;event.preventDefault();buttons[target].focus();selectNearest(target);
  });
  stage.addEventListener("pointerdown",event=>{
    if(event.button!==0)return;
    if(mode==="film"){position=Math.round(-Number(gsap.getProperty(ring,"rotationY"))/step);stop();interactive();}
    stop();drag={x:event.clientX,y:event.clientY,angle:Number(gsap.getProperty(ring,"rotationY")),id:event.pointerId,active:false};suppressClick=false;
  });
  stage.addEventListener("pointermove",event=>{
    if(!drag||drag.id!==event.pointerId)return;
    const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
    if(!drag.active&&Math.abs(dy)>Math.abs(dx)&&Math.abs(dy)>8){drag=undefined;return;}
    if(!drag.active&&Math.abs(dx)>8){drag.active=true;stage.setPointerCapture(event.pointerId);}
    if(!drag.active)return;
    gsap.set(ring,{rotationY:drag.angle+dx*.16});label(-(drag.angle+dx*.16)/step);
  });
  function endDrag(event) {
    if(!drag||drag.id!==event.pointerId)return;
    const active=drag.active;drag=undefined;suppressClick=active;
    if(active)select(Math.round(-Number(gsap.getProperty(ring,"rotationY"))/step));
  }
  window.addEventListener("pointerup",endDrag);stage.addEventListener("pointercancel",endDrag);
  stage.addEventListener("click",event=>{if(suppressClick){suppressClick=false;return;}const card=event.target.closest("[data-agent-index]");if(card)selectNearest(Number(card.dataset.agentIndex));});
  document.addEventListener("visibilitychange",schedule);
  if("IntersectionObserver" in window)new window.IntersectionObserver(entries=>{visible=entries[0].isIntersecting;schedule();},{threshold:.05}).observe(stage);
  window.addEventListener("resize",size);
  motionPreference?.addEventListener("change",()=>{if(reducedMotion()){stop();interactive();label(position);}});
  interactive();label(0);schedule();
}

revealHeadline();
setupOrbit();
window.setupFilmDemo();
