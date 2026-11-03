/* Adapted directly from ../video/claude, reference 5672fd8.
 * Original layout, geometry, easing and timeline retained. See promo/README.md. */

// Both playback and manual threshold feedback use the film's original impulse.
window.addFilmShake = (timeline, at = 0) => timeline.to("#s4-shake", {
  keyframes: [{ x: 6 }, { x: -5 }, { x: 4 }, { x: -2 }, { x: 0 }],
  duration: 0.2, ease: "none",
}, at);

    window.createS4Film = function () {
      const gsap = window.gsap;
      const OrbisPhone = window.OrbisPhone;
      // ---------------- build ----------------
      const phone = document.getElementById("s4-phone");
      const body = OrbisPhone.build(phone, { screen: document.getElementById("s4-scr"), thickness: 46 });
      const P = 393;
      // coin edge: thin metallic discs between the two faces
      const coinRot = document.getElementById("s4-coinrot");
      for (let k = 0; k < 13; k++) {
        const d = document.createElement("div");
        d.className = "rimd";
        d.style.filter = `brightness(${0.82 + 0.3 * Math.exp(-Math.pow((k - 6) / 3, 2))})`;
        d.style.transform = `translateZ(${-3.6 + k * 0.6}px)`;
        coinRot.insertBefore(d, coinRot.firstChild);
      }
      // home cards (data; editable)
      const CARDS = [
        { id: "s4-c0", icon: "a-claudecode", t: "修首页下拉回弹", p: "/Projects/orbis", n: "Claude Code", c: "var(--claude)" },
        { id: "s4-c1", icon: "a-codexc", t: "对齐移动端的使用体验", p: "/Projects/orbis", n: "Codex", c: "var(--codex)" },
        { id: "s4-c2", icon: "a-dsh", t: "检查服务端连接状态", p: "/Projects/orbis", n: "DeepSeek", c: "var(--dsh)" },
        { id: "s4-c3", icon: "a-pi", t: "梳理项目中的页面结构", p: "/Projects/website", n: "Pi", c: "var(--pi)" },
        { id: "s4-c4", icon: "a-codexc", t: "整理下载页布局", p: "/Projects/orbis", n: "Codex 桌面版", c: "var(--codex)" },
        { id: "s4-cn", icon: "a-claudecode", t: "新会话", p: "/Projects/orbis", n: "Claude Code", c: "var(--claude)", fresh: true },
      ];
      const list = document.getElementById("s4-list");
      CARDS.forEach(c => {
        const d = document.createElement("div");
        d.className = "scard raised"; d.id = c.id;
        d.innerHTML = '<div class="sel"></div><div class="well inset"><i class="agent '+c.icon+'"></i></div><div class="t"></div><div class="p mono"></div><div class="s"><span class="card-agent"></span><span class="dot"></span><span class="card-state">空闲</span></div><div class="ind"><b><i class="ico i-check"></i></b></div>';
        d.querySelector('.t').textContent=c.t; d.querySelector('.p').textContent=c.p;
        d.querySelector('.card-agent').textContent=c.n; d.querySelector('.card-agent').style.color=c.c;
        if(c.fresh) d.querySelector('.card-state').innerHTML='<span class="st-a">启动中…</span><span class="st-b">空闲</span>';
        else d.querySelector('.card-state').replaceWith(document.createTextNode('空闲'));
        list.appendChild(d);
      });
      // chat: streaming paragraph split into characters
      const p2 = document.getElementById("s4-p2");
      const P2TEXT = p2.textContent;
      p2.innerHTML = [...P2TEXT].map((ch) => `<span>${ch}</span>`).join("");
      const p2chars = [...p2.children];
      // layout measurements (layout boxes are unaffected by transforms)
      const msgs = document.getElementById("s4-msgs");
      const VIEW = 620;
      const off = (el) => {
        let y = 0;
        for (let e = el; e && e !== msgs; e = e.offsetParent) y += e.offsetTop;
        return y;
      };
      const ab = document.getElementById("s4-ab");
      const after = document.getElementById("s4-after");

      const finalBottom = off(ab) + ab.offsetHeight;
      const followAt = (bottom) => Math.min(0, VIEW - 16 - bottom);
      // lines of the streaming paragraph: the bottom edge of each line, and the char that starts it
      const lineStarts = [];
      let lastTop = -1;
      p2chars.forEach((c, i) => {
        if (c.offsetTop !== lastTop) {
          lastTop = c.offsetTop;
          lineStarts.push(i);
        }
      });
      const lineH = 24;
      const qb = document.getElementById("s4-qb");
      const firstMa = qb.previousElementSibling;
      const firstBottom = off(firstMa) + firstMa.offsetHeight;
      const qbBottom = off(qb) + qb.offsetHeight;
      const patch = document.getElementById("s4-patch");
      const bash = document.getElementById("s4-bash");
      const tchars = (() => {
        const t = document.getElementById("s4-tchars");
        t.innerHTML = [...t.textContent].map((ch) => `<span>${ch}</span>`).join("");
        return [...t.children];
      })();
      const ask = document.getElementById("s4-ask");
      const askTop = 732 - ask.offsetHeight;
      const allow = document.getElementById("s4-allow");
      const allowX = 16 + allow.offsetLeft + allow.offsetWidth / 2;
      const allowY = askTop + allow.offsetTop + allow.offsetHeight / 2;
      const p2Top = off(p2);

      // ---------------- helpers ----------------
      const tl = gsap.timeline({ paused: true });
      gsap.set("#s4-pos", { x: 0, y: 0, z: -900, scale: 1, rotationY: 0 });
      gsap.set("#s4-rot", { rotationY: -28, rotationX: 6 });
      gsap.set("#s4-zoom", { x: 0, y: 0, scale: 1 });
      gsap.set("#s4-shadow", { opacity: 0, scaleX: 0.7 });
      gsap.set(body.glare, { backgroundPosition: "95% 0" });
      gsap.set(["#s4-chat", "#s4-diff", "#s4-dl", "#s4-set"], { x: P, scale: 1, borderRadius: 0 });
      gsap.set("#s4-new", { y: 852 });
      gsap.set("#s4-drawer", { x: -350 });
      CARDS.forEach((c, i) => gsap.set("#" + c.id, { x: 0, y: 0, top: c.fresh ? 180 : 180 + 110 * i }));
      gsap.set("#s4-cn", { y: 760, opacity: 0 });
      gsap.set(".scard .sel", { clipPath: "circle(0px at 50% 50%)" });
      gsap.set("#s4-msgs", { y: followAt(firstBottom) });
      gsap.set(["#s4-qb", "#s4-ab"], { opacity: 0 });
      gsap.set(tchars, { display: "none" });
      gsap.set("#s4-ask", { y: askTop });
      gsap.set("#s4-askst", { top: 0, y: 688 });
      gsap.set(after, { opacity: 0 });
      gsap.set("#s4-remind", { opacity: 0, x: 32, y: -12 });
      gsap.set("#s4-jump", { opacity: 0, scale: 0.85 });
      gsap.set("#s4-coin", { "--a": 0 });

      const tap = (x, y, t, hold = 0.12) => {
        tl.set("#s4-touch", { x, y }, t);
        tl.fromTo("#s4-touch", { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.08, ease: "power2.out", immediateRender: false }, t);
        tl.to("#s4-touch", { opacity: 0, scale: 1.12, duration: 0.18, ease: "power1.out" }, t + hold);
      };
      const drag = (x0, y0, x1, y1, t, d, ease = "power1.inOut") => {
        tl.set("#s4-touch", { x: x0, y: y0, scale: 1 }, t);
        tl.to("#s4-touch", { opacity: 1, duration: 0.07 }, t);
        tl.to("#s4-touch", { x: x1, y: y1, duration: d, ease }, t + 0.05);
        tl.to("#s4-touch", { opacity: 0, duration: 0.12 }, t + 0.05 + d);
      };
      let z = 10;
      const push = (page, under, t) => {
        tl.set(page, { zIndex: z++, x: P, scale: 1, borderRadius: 0 }, t);
        tl.to(page, { x: 0, duration: 0.42, ease: "expo.out" }, t);
        if (under) tl.to(under, { x: -P * 0.3, duration: 0.42, ease: "expo.out" }, t);
      };
      const pop = (page, under, t) => {
        tl.to(page, { x: P, duration: 0.36, ease: "power3.inOut" }, t);
        if (under) tl.to(under, { x: 0, duration: 0.36, ease: "power3.inOut" }, t);
      };
      const edgeBack = (page, under, t) => {
        drag(12, 430, 168, 430, t, 0.55);
        tl.to(page, { x: 156, scale: 0.96, borderRadius: 24, duration: 0.55, ease: "power1.inOut" }, t + 0.05);
        tl.to(under, { x: -P * 0.3 + 156 * 0.3, duration: 0.55, ease: "power1.inOut" }, t + 0.05);
        tl.to(page, { x: P + 30, duration: 0.18, ease: "power2.in" }, t + 0.62);
        tl.to(under, { x: 0, duration: 0.3, ease: "power2.out" }, t + 0.62);
      };
      // camera: keep screen point (px, py) at frame point (qx, qy) with zoom s
      const screenToFrame = (px, py) => [960 + (px + 10 - 206.5) * 0.985, 545 + (py + 10 - 436)];
      const zoomTo = (px, py, s, t, d = 0.6, q = [960, 540]) => {
        const [fx, fy] = screenToFrame(px, py);
        tl.to("#s4-zoom", { scale: s, x: q[0] - 960 - s * (fx - 960), y: q[1] - 540 - s * (fy - 540), duration: d, ease: "power2.inOut" }, t);
      };
      const shake = (t) => window.addFilmShake(tl, t);

      // ---------------- 0. arrival through the ring ----------------
      tl.to("#s4-pos", { z: 0, duration: 0.95, ease: "expo.out" }, 0);
      tl.to("#s4-rot", { rotationY: -9, rotationX: 3, duration: 1.1, ease: "expo.out" }, 0);
      tl.to("#s4-shadow", { opacity: 1, scaleX: 1, duration: 0.9, ease: "expo.out" }, 0.1);
      tl.to(body.glare, { backgroundPosition: "62% 0", duration: 1.1, ease: "expo.out" }, 0);
      tl.to("#s4-rot", { rotationY: -5, duration: 35, ease: "none" }, 1.1);

      // ================ 1. chat ================
      tap(140, 228, 1.05, 0.14);
      tl.to("#s4-c0", { scale: 0.98, duration: 0.08, ease: "power2.out" }, 1.05);
      tl.to("#s4-c0", { scale: 1, duration: 0.2, ease: "power2.out" }, 1.19);
      push("#s4-chat", "#s4-home", 1.2);
      tl.to("#s4-homedim", { opacity: 0.12, duration: 0.42, ease: "expo.out" }, 1.2);
      zoomTo(196, 450, 1.2, 1.3, 0.7);
      // type the next question; the send button wakes with the first character
      const TAPIN = 1.95;
      tap(200, 796, TAPIN, 0.1);
      tl.set("#s4-ph", { opacity: 0 }, TAPIN + 0.08);
      tl.set("#s4-caret", { opacity: 1 }, TAPIN + 0.08);
      const TYPE = 2.08;
      tchars.forEach((c, i) => tl.set(c, { display: "inline" }, TYPE + i * 0.06));
      tl.to("#s4-send", { color: "#b4572e", duration: 0.15, ease: "power1.out" }, TYPE);
      // send: the text leaves the field as a bubble, nudges right, then flies up into its place in the
      // transcript while the list makes room (SendFlight, ADR-0058; slowed a little to be read on film)
      const SEND = 3.0;
      tap(354, 796, SEND, 0.1);
      tl.to("#s4-send", { scale: 0.9, duration: 0.07, ease: "power2.out" }, SEND);
      tl.to("#s4-send", { scale: 1, duration: 0.22, ease: "back.out(2)" }, SEND + 0.07);
      tl.set("#s4-typed", { opacity: 0 }, SEND + 0.05);
      tl.set("#s4-ph", { opacity: 1 }, SEND + 0.14);
      tl.to("#s4-send", { color: "#a9b3c4", duration: 0.15, ease: "power1.out" }, SEND + 0.05);
      const qbY = followAt(qbBottom);
      const sfFrom = { x: 74, y: 769 + 27 - qb.offsetHeight / 2 };
      const sfTo = { x: 16 + qb.offsetLeft, y: 124 + off(qb) + qbY };
      tl.set("#s4-sf", { x: sfFrom.x, y: sfFrom.y, scale: 0.96, opacity: 1, transformOrigin: "0% 50%" }, SEND + 0.05);
      tl.to("#s4-sf", { x: sfFrom.x + 24, duration: 0.08, ease: "power1.out" }, SEND + 0.05);
      tl.to("#s4-sf", { x: sfTo.x, y: sfTo.y, scale: 1, duration: 0.5, ease: "power3.inOut" }, SEND + 0.13);
      tl.to("#s4-msgs", { y: qbY, duration: 0.5, ease: "power3.inOut" }, SEND + 0.1);
      tl.to("#s4-qb", { opacity: 1, duration: 0.1, ease: "none" }, SEND + 0.58);
      tl.to("#s4-sf", { opacity: 0, duration: 0.12, ease: "none" }, SEND + 0.6);
      tl.set("#s4-cidle", { opacity: 0 }, SEND + 0.35);
      tl.set("#s4-crun", { opacity: 1 }, SEND + 0.35);
      tl.set("#s4-cdot", { background: "#1B7A57" }, SEND + 0.35);
      // the reply: two edits, then the explanation streams in ink (0.12 s per character, 0.03 s apart)
      const ASST = 3.7;
      tl.fromTo("#s4-ab", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.3, ease: "power3.out", immediateRender: false }, ASST);
      tl.to("#s4-msgs", { y: followAt(p2Top + lineH), duration: 0.45, ease: "power2.out" }, ASST);
      const STREAM = 4.1;
      p2chars.forEach((c, i) => tl.fromTo(c, { opacity: 0, filter: "blur(6px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.12, ease: "power1.out", immediateRender: false }, STREAM + i * 0.03));
      lineStarts.forEach((ci, li) => {
        if (li === 0) return;
        tl.to("#s4-msgs", { y: followAt(p2Top + lineH * (li + 1)), duration: 0.24, ease: "power2.out" }, STREAM + ci * 0.03);
      });
      const streamEnd = STREAM + p2chars.length * 0.03 + 0.12;
      const PATCH = streamEnd + 0.04;
      tl.to("#s4-patch", { opacity: 1, duration: 0.25, ease: "power1.out" }, PATCH);
      tl.to("#s4-msgs", { y: followAt(off(patch) + patch.offsetHeight), duration: 0.45, ease: "power2.out" }, PATCH);
      // before running the tests Claude asks: the request floats above the composer
      const ASK = PATCH + 0.4;
      tl.fromTo("#s4-ask", { opacity: 0, y: askTop + 24 }, { opacity: 1, y: askTop, duration: 0.22, ease: "power2.out", immediateRender: false }, ASK);
      zoomTo(196, askTop + ask.offsetHeight / 2, 1.45, ASK - 0.05, 0.6);
      const ALLOW = ASK + 1.25;
      tap(allowX, allowY, ALLOW, 0.12);
      tl.to("#s4-allow", { scale: 0.96, duration: 0.08, ease: "power2.out" }, ALLOW);
      tl.to("#s4-allow", { scale: 1, duration: 0.2, ease: "power2.out" }, ALLOW + 0.1);
      // answered: the request folds away at once; a short status holds its place until the receipt
      tl.to("#s4-ask", { opacity: 0, y: askTop + 8, duration: 0.16, ease: "power1.in" }, ALLOW + 0.14);
      tl.fromTo("#s4-askst", { opacity: 0 }, { opacity: 1, duration: 0.18, ease: "power1.out", immediateRender: false }, ALLOW + 0.22);
      tl.fromTo("#s4-askspin", { rotation: 0, transformOrigin: "50% 50%" }, { rotation: 360, transformOrigin: "50% 50%", duration: 0.8, ease: "steps(8)", immediateRender: false }, ALLOW + 0.22);
      tl.to("#s4-askspin", { opacity: 0, duration: 0.12 }, ALLOW + 0.95);
      tl.to("#s4-askst", { opacity: 0, duration: 0.25, ease: "power1.in" }, ALLOW + 1.25);
      zoomTo(196, 450, 1.2, ALLOW + 0.35, 0.6);
      // the tests run (the row stays clear of the status while it is shown)
      const bashBottom = off(bash) + bash.offsetHeight;
      tl.to("#s4-bash", { opacity: 1, duration: 0.2, ease: "power1.out" }, ALLOW + 0.3);
      tl.to("#s4-msgs", { y: followAt(bashBottom) - 52, duration: 0.45, ease: "power2.out" }, ALLOW + 0.3);
      tl.set("#s4-bashrun", { opacity: 0 }, ALLOW + 1.05);
      tl.set("#s4-bashok", { opacity: 1 }, ALLOW + 1.05);
      // scroll up to read: the latest question leaves the view below, the reminder and the jump button arrive
      const UP = ALLOW + 1.35;
      drag(196, 300, 196, 640, UP, 0.55, "power2.out");
      tl.to("#s4-msgs", { y: Math.min(0, 640 - off(qb)), duration: 0.75, ease: "power3.out" }, UP + 0.05);
      tl.to("#s4-remind", { opacity: 1, x: 0, y: 0, duration: 0.22, ease: "power2.out" }, UP + 0.42);
      tl.to("#s4-jump", { opacity: 1, scale: 1, duration: 0.16, ease: "power2.out" }, UP + 0.46);
      // meanwhile the turn finishes below the fold
      tl.to(after, { opacity: 1, duration: 0.01 }, UP + 0.8);
      tl.set("#s4-cidle", { opacity: 1 }, UP + 1.0);
      tl.set("#s4-crun", { opacity: 0 }, UP + 1.0);
      tl.set("#s4-cdot", { background: "#8E97A8" }, UP + 1.0);
      // everything after the chat lands three bars (5.625 s) later than in v6, so it keeps its beat
      const OPEN = 12.185;
      const JUMP = OPEN - 1.25;
      const TAPQ = JUMP - 1.25;
      // tap the reminder: the transcript flies up until the question sits at the top of the view
      tap(196, 148, TAPQ, 0.12);
      tl.to("#s4-remind", { scale: 0.97, duration: 0.08, ease: "power2.out" }, TAPQ);
      tl.to("#s4-remind", { scale: 1, duration: 0.18, ease: "power2.out" }, TAPQ + 0.1);
      tl.to("#s4-msgs", { y: Math.max(followAt(finalBottom), 6 - off(qb)), duration: 0.6, ease: "power3.inOut" }, TAPQ + 0.12);
      tl.to("#s4-remind", { opacity: 0, x: 32, y: -12, duration: 0.16, ease: "power2.in" }, TAPQ + 0.24);
      // jump to the latest: the reply is done, with its files and the turn's diff
      tap(351, 700, JUMP);
      tl.to("#s4-jump", { scale: 0.88, duration: 0.08 }, JUMP);
      tl.to("#s4-msgs", { y: followAt(finalBottom), duration: 0.6, ease: "power2.inOut" }, JUMP + 0.1);
      tl.to("#s4-jump", { opacity: 0, scale: 0.85, duration: 0.16, ease: "power2.in" }, JUMP + 0.12);
      // open the turn's file changes
      const yAt = (el) => off(el) + el.offsetHeight / 2 + 118 + 6 + followAt(finalBottom);
      const diffRow = document.getElementById("s4-diffrow");
      zoomTo(196, yAt(diffRow) - 120, 1.38, JUMP + 0.75, 0.6);
      tap(200, yAt(diffRow), OPEN);
      push("#s4-diff", "#s4-chat", OPEN + 0.12);
      zoomTo(196, 400, 1.28, OPEN + 0.3, 0.6);
      const FLIP = OPEN + 1.0;
      drag(330, 430, 90, 430, FLIP, 0.32, "power2.in");
      tl.to("#s4-pager", { x: -P, duration: 0.5, ease: "power3.inOut" }, FLIP + 0.06);
      tl.set("#s4-pg1", { opacity: 0 }, FLIP + 0.3);
      tl.set("#s4-pg2", { opacity: 1 }, FLIP + 0.3);
      const BACK1 = FLIP + 1.0;
      tap(42, 84, BACK1);
      pop("#s4-diff", "#s4-chat", BACK1 + 0.1);
      // downloads: each file flies into the download button
      zoomTo(196, 420, 1.12, BACK1 + 0.3, 0.55);
      const fly = (row, t, badge) => {
        // the whole row is the button: tap the file name; the icon leaves from under the finger (M16)
        const fx = 16 + row.offsetLeft + 92;
        const fy = yAt(row);
        tap(fx, fy, t - 0.16, 0.12);
        tl.set(row, { boxShadow: "inset 3px 3px 6px rgba(166, 178, 198, 0.62), inset -3px -3px 6px rgba(255, 255, 255, 0.85)" }, t - 0.15);
        tl.to(row, { scale: 0.98, duration: 0.08, ease: "power2.out" }, t - 0.15);
        tl.set(row, { boxShadow: "4px 4px 9px rgba(166, 178, 198, 0.62), -4px -4px 9px rgba(255, 255, 255, 0.9)" }, t - 0.02);
        tl.to(row, { scale: 1, duration: 0.22, ease: "power2.out" }, t - 0.02);
        const to = { x: 350, y: 84 };
        const top = Math.min(fy, to.y);
        const c = { x: (fx + to.x) / 2, y: top - Math.min(120, top / 2) };
        const kf = [];
        for (let k = 1; k <= 12; k++) {
          const time = k / 12;
          const s = time * time * (3 - 2 * time);
          const u = 1 - s;
          kf.push({ x: u * u * fx + 2 * u * s * c.x + s * s * to.x, y: u * u * fy + 2 * u * s * c.y + s * s * to.y, scale: (28 + (16 - 28) * s) / 28, opacity: time < 0.846 ? 1 : (1 - time) / 0.154 });
        }
        tl.set("#s4-fly", { x: fx, y: fy, scale: 1, opacity: 1 }, t);
        tl.to("#s4-fly", { keyframes: kf, duration: 0.52, ease: "none" }, t);
        tl.to("#s4-dlglyph", { y: 4, duration: 0.09, ease: "power2.out" }, t + 0.5);
        tl.to("#s4-dlglyph", { y: 0, duration: 0.22, ease: "back.out(3)" }, t + 0.59);
        tl.to("#s4-dlbtn", { scale: 0.88, duration: 0.09, ease: "power2.out" }, t + 0.5);
        tl.to("#s4-dlbtn", { scale: 1, duration: 0.22, ease: "back.out(2.5)" }, t + 0.59);
        if (badge === 1) tl.fromTo("#s4-dlbadge", { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.25, ease: "back.out(2.6)", immediateRender: false }, t + 0.52);
        else {
          tl.set("#s4-bd1", { opacity: 0 }, t + 0.52);
          tl.set("#s4-bd2", { opacity: 1 }, t + 0.52);
          tl.fromTo("#s4-dlbadge", { scale: 1.35 }, { scale: 1, duration: 0.25, ease: "back.out(2.6)", immediateRender: false }, t + 0.52);
        }
      };
      const FLY1 = BACK1 + 0.75;
      fly(document.getElementById("s4-f0"), FLY1, 1);
      fly(document.getElementById("s4-f1"), FLY1 + 0.72, 2);
      const DL = FLY1 + 1.55;
      tap(350, 84, DL);
      push("#s4-dl", "#s4-chat", DL + 0.1);
      tl.fromTo("#s4-dl0bar", { scaleX: 0.64 }, { scaleX: 1, duration: 0.7, ease: "power1.out", immediateRender: false }, DL + 0.3);
      tl.set("#s4-d0a", { opacity: 0 }, DL + 1.0);
      tl.set("#s4-d0b", { opacity: 1 }, DL + 1.0);
      // and back: the page shrinks to 0.96, rounds its corners and follows the finger
      const EDGE = DL + 1.35;
      edgeBack("#s4-dl", "#s4-chat", EDGE);
      const HOME1 = EDGE + 1.15;
      tap(42, 84, HOME1);
      pop("#s4-chat", "#s4-home", HOME1 + 0.1);
      tl.to("#s4-homedim", { opacity: 0, duration: 0.36, ease: "power3.inOut" }, HOME1 + 0.1);
      zoomTo(196, 426, 1, HOME1 + 0.2, 0.6);

      // ================ 2. session list: swipe to close, long-press to multi-select ================
      const L = HOME1 + 0.9;
      zoomTo(196, 400, 1.3, L, 0.6);
      drag(300, 338, 110, 338, L + 0.5, 0.6);
      tl.to("#s4-c1", { x: -190, duration: 0.6, ease: "power1.inOut" }, L + 0.55);
      const TH = L + 0.98;
      tl.to("#s4-close-r", { opacity: 0, duration: 0.16, ease: "power1.out" }, TH);
      tl.to("#s4-close-g", { opacity: 1, duration: 0.16, ease: "power1.out" }, TH);
      shake(TH);
      tl.to("#s4-c1", { x: -430, duration: 0.18, ease: "power2.in" }, L + 1.2);
      tl.set("#s4-close", { opacity: 0 }, L + 1.38);
      tl.to(["#s4-c2", "#s4-c3", "#s4-c4"], { y: -110, duration: 0.16, ease: "power2.out" }, L + 1.38);
      // long-press: the selection spreads from the finger, the toolbar morphs
      const LP = L + 2.2;
      tl.set("#s4-touch", { x: 230, y: 338, scale: 1 }, LP);
      tl.to("#s4-touch", { opacity: 1, duration: 0.08 }, LP);
      tl.to("#s4-c2", { scale: 0.985, duration: 0.35, ease: "power1.inOut" }, LP);
      const SEL = LP + 0.45;
      tl.to("#s4-touch", { opacity: 0, duration: 0.16 }, SEL + 0.05);
      tl.to("#s4-c2", { scale: 1, duration: 0.2, ease: "power2.out" }, SEL);
      tl.fromTo("#s4-c2 .sel", { clipPath: "circle(0px at 212px 48px)" }, { clipPath: "circle(380px at 212px 48px)", duration: 0.26, ease: "power2.out", immediateRender: false }, SEL);
      tl.to(".scard .ind", { opacity: 1, duration: 0.2, ease: "power1.out" }, SEL);
      tl.to("#s4-c2 .ind b", { opacity: 1, duration: 0.18, ease: "power2.out" }, SEL + 0.05);
      tl.to("#s4-b1", { y: 6, rotation: 45, duration: 0.26, ease: "power2.inOut" }, SEL);
      tl.to("#s4-b3", { y: -6, rotation: -45, duration: 0.26, ease: "power2.inOut" }, SEL);
      tl.to("#s4-b2", { scaleX: 0, opacity: 0, duration: 0.16, ease: "power2.in" }, SEL);
      tl.to("#s4-brand", { opacity: 0, duration: 0.14, ease: "power1.in" }, SEL);
      tl.to("#s4-seltitle", { opacity: 1, duration: 0.16, ease: "power1.out" }, SEL + 0.1);
      tl.to("#s4-dlhome", { x: 24, opacity: 0, duration: 0.16, ease: "power2.in" }, SEL);
      tl.to("#s4-gearbtn", { x: -24, opacity: 0, duration: 0.16, ease: "power2.in" }, SEL);
      tl.fromTo("#s4-closeall", { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.1, ease: "power2.out", immediateRender: false }, SEL + 0.16);
      const SEL2 = SEL + 0.9;
      tap(230, 448, SEL2);
      tl.fromTo("#s4-c3 .sel", { clipPath: "circle(0px at 212px 48px)" }, { clipPath: "circle(380px at 212px 48px)", duration: 0.26, ease: "power2.out", immediateRender: false }, SEL2 + 0.05);
      tl.to("#s4-c3 .ind b", { opacity: 1, duration: 0.18, ease: "power2.out" }, SEL2 + 0.08);
      tl.set("#s4-cnt1", { opacity: 0 }, SEL2 + 0.08);
      tl.set("#s4-cnt2", { opacity: 1 }, SEL2 + 0.08);
      const CL = SEL2 + 0.85;
      tap(328, 84, CL);
      tl.to("#s4-closeall", { scale: 0.94, duration: 0.08 }, CL);
      tl.to("#s4-c2", { x: -430, duration: 0.18, ease: "power2.in" }, CL + 0.12);
      tl.to("#s4-c3", { x: -430, duration: 0.18, ease: "power2.in" }, CL + 0.18);
      tl.to("#s4-c4", { y: -330, duration: 0.2, ease: "power2.out" }, CL + 0.38);
      tl.to(".scard .ind", { opacity: 0, duration: 0.16 }, CL + 0.3);
      tl.to("#s4-closeall", { opacity: 0, duration: 0.1 }, CL + 0.3);
      tl.to("#s4-b1", { y: 0, rotation: 0, duration: 0.26, ease: "power2.inOut" }, CL + 0.3);
      tl.to("#s4-b3", { y: 0, rotation: 0, duration: 0.26, ease: "power2.inOut" }, CL + 0.3);
      tl.to("#s4-b2", { scaleX: 1, opacity: 1, duration: 0.16, ease: "power2.out" }, CL + 0.4);
      tl.to("#s4-seltitle", { opacity: 0, duration: 0.12 }, CL + 0.3);
      tl.to("#s4-brand", { opacity: 1, duration: 0.16 }, CL + 0.4);
      tl.to(["#s4-dlhome", "#s4-gearbtn"], { x: 0, opacity: 1, duration: 0.16, ease: "power2.out" }, CL + 0.42);
      zoomTo(196, 426, 1, CL + 0.7, 0.6);

      // ================ 3. directory drawer, new session sheet, the new card lands ================
      const D = CL + 1.4;
      tap(42, 84, D);
      tl.to("#s4-drawer", { x: 0, duration: 0.4, ease: "expo.out" }, D + 0.1);
      tl.to("#s4-scrim", { opacity: 0.28, duration: 0.3, ease: "power1.out" }, D + 0.1);
      zoomTo(170, 330, 1.25, D + 0.25, 0.6);
      const NEW = D + 1.3;
      tap(95, 152, NEW);
      tl.to("#s4-newbtn", { scale: 0.95, duration: 0.08 }, NEW);
      tl.to("#s4-newbtn", { scale: 1, duration: 0.18 }, NEW + 0.1);
      tl.to("#s4-drawer", { x: -350, duration: 0.3, ease: "power2.in" }, NEW + 0.15);
      tl.to("#s4-scrim", { opacity: 0.22, duration: 0.3 }, NEW + 0.15);
      tl.set("#s4-new", { zIndex: 40 }, NEW + 0.2);
      tl.to("#s4-new", { y: 0, duration: 0.45, ease: "expo.out" }, NEW + 0.3);
      tl.set("#s4-nb-pi .sel", { opacity: 1 }, NEW + 0.3);
      tl.set("#s4-nb-pi .ico", { opacity: 1 }, NEW + 0.3);
      zoomTo(196, 420, 1.2, NEW + 0.5, 0.6);
      const PICK = NEW + 1.25;
      tap(106, 54 + 244 + 30, PICK);
      tl.set("#s4-nb-pi .sel", { opacity: 0 }, PICK + 0.05);
      tl.set("#s4-nb-pi .ico", { opacity: 0 }, PICK + 0.05);
      tl.set("#s4-nb-claude .sel", { opacity: 1 }, PICK + 0.05);
      tl.set("#s4-nb-claude .ico", { opacity: 1 }, PICK + 0.05);
      tl.to("#s4-nc-pi", { opacity: 0, duration: 0.15 }, PICK + 0.05);
      tl.to("#s4-nc-claude", { opacity: 1, duration: 0.15 }, PICK + 0.1);
      const CREATE = PICK + 0.85;
      tap(196, 54 + 700 + 28, CREATE);
      tl.to("#s4-nc-claude", { scale: 0.96, duration: 0.08 }, CREATE);
      tl.to("#s4-nc-claude", { scale: 1, duration: 0.14 }, CREATE + 0.1);
      tl.to("#s4-new", { y: 852, duration: 0.36, ease: "power2.in" }, CREATE + 0.18);
      tl.to("#s4-scrim", { opacity: 0, duration: 0.3 }, CREATE + 0.2);
      zoomTo(196, 360, 1.22, CREATE + 0.3, 0.6);
      // the new card rises from the bottom edge into the first slot; the list makes room
      const RISE = CREATE + 0.58;
      tl.to(["#s4-c0", "#s4-c4"], { y: "+=110", duration: 0.4, ease: "power2.inOut" }, RISE);
      tl.set("#s4-cn", { opacity: 1, zIndex: 40, y: 720, scale: 1.05, boxShadow: "10px 22px 34px rgba(42, 51, 68, 0.24), -4px -4px 9px rgba(255, 255, 255, 0.9)" }, RISE + 0.1);
      tl.to("#s4-cn", { y: -10, scale: 1.04, duration: 0.72, ease: "power2.out" }, RISE + 0.1);
      tl.to("#s4-cn", { y: 0, scale: 1, boxShadow: "4px 4px 9px rgba(166, 178, 198, 0.62), -4px -4px 9px rgba(255, 255, 255, 0.9)", duration: 0.3, ease: "power2.inOut" }, RISE + 0.82);
      tl.set("#s4-cn .st-a", { opacity: 0 }, RISE + 1.5);
      tl.set("#s4-cn .st-b", { opacity: 1 }, RISE + 1.5);
      zoomTo(196, 426, 1, RISE + 1.3, 0.6);

      // ================ 4. settings: Codex already shows its reading; Claude Code is queried, then the coin turns ================
      const S = RISE + 2.1;
      tap(350, 84, S);
      tl.to("#s4-gear", { rotation: 90, duration: 0.26, ease: "power2.out" }, S);
      push("#s4-set", "#s4-home", S + 0.12);
      zoomTo(150, 360, 2.0, S + 0.6, 0.7, [880, 560]);
      const Q = S + 1.6;
      tap(54, 418, Q);
      tl.to("#s4-coin", { scale: 0.92, duration: 0.08 }, Q);
      tl.to("#s4-coin", { scale: 1, duration: 0.2, ease: "back.out(2)" }, Q + 0.08);
      tl.set("#s4-spin", { opacity: 1 }, Q + 0.1);
      tl.fromTo("#s4-spin", { rotation: 0, transformOrigin: "50% 50%" }, { rotation: 360, transformOrigin: "50% 50%", duration: 1.0, ease: "none", immediateRender: false }, Q + 0.1);
      const READ = Q + 1.1;
      tl.set("#s4-spin", { opacity: 0 }, READ);
      tl.set("#s4-track", { attr: { "stroke-dasharray": "135.1 0" } }, READ);
      tl.to("#s4-arc", { strokeDashoffset: 135.1 * (1 - 0.72), duration: 0.7, ease: "power1.out" }, READ);
      tl.to("#s4-vnone", { y: -16, opacity: 0, duration: 0.18, ease: "power2.in" }, READ);
      tl.fromTo("#s4-v72", { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.22, ease: "power2.out", immediateRender: false }, READ + 0.1);
      // the coin turns over on its diagonal axis: weekly on the back; then back again
      const turn = (t, from, toWeekly) => {
        tl.fromTo("#s4-coin", { "--a": from }, { "--a": from + 90, duration: 0.22, ease: "power2.in", immediateRender: false }, t);
        tl.to("#s4-coin", { "--a": from + 180, duration: 0.34, ease: "power3.out" }, t + 0.22);
        tl.to("#s4-cshadow", { scaleX: 0.35, opacity: 0.5, duration: 0.22, ease: "power2.in" }, t);
        tl.to("#s4-cshadow", { scaleX: 1, opacity: 1, duration: 0.34, ease: "power3.out" }, t + 0.22);
        tl.fromTo(["#s4-sheen1", "#s4-sheen2"], { backgroundPosition: "100% 0" }, { backgroundPosition: "0% 0", duration: 0.56, ease: "power2.inOut", immediateRender: false }, t);
        const a = toWeekly ? ["#s4-l5h", "#s4-v72"] : ["#s4-lwk", "#s4-v41"];
        const b = toWeekly ? ["#s4-lwk", "#s4-v41"] : ["#s4-l5h", "#s4-v72"];
        tl.to(a, { y: -16, opacity: 0, duration: 0.16, ease: "power2.in" }, t + 0.12);
        tl.fromTo(b, { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.24, ease: "power2.out", immediateRender: false }, t + 0.24);
      };
      zoomTo(54, 418, 3.1, READ + 0.45, 0.5, [900, 560]);
      turn(READ + 1.05, 0, true);
      turn(READ + 2.05, 180, false);
      // back home, the camera pulls out
      const OUT = READ + 3.0;
      zoomTo(196, 426, 1, OUT, 0.7);
      tap(42, 84, OUT + 0.55);
      pop("#s4-set", "#s4-home", OUT + 0.65);
      tl.to("#s4-gear", { rotation: 0, duration: 0.3 }, OUT + 0.65);
      tl.to("#s4-rot", { rotationY: 0, rotationX: 0, duration: 0.8, ease: "power2.inOut" }, OUT + 0.6);
      tl.to(body.glare, { backgroundPosition: "55% 0", duration: 0.8, ease: "power2.inOut" }, OUT + 0.6);

      window.__S4_END = OUT + 1.5;
      return { timeline: tl, marks: { SEND, ASK, ALLOW, UP, TAPQ, JUMP, OPEN, FLIP, BACK1, FLY1, DL, EDGE, HOME1, L, LP, SEL, SEL2, CL, D, NEW, PICK, CREATE, RISE, S, Q, READ, OUT }, layout: { off, followAt, finalBottom, qb, msgs, yAt, askTop }, cards: CARDS };
    };

    window.createS2Film = function () {
      const gsap = window.gsap;
      const OrbisPhone = window.OrbisPhone;
      // ---------- build the 3D bodies once (deterministic, before any tween) ----------
      const phone = document.getElementById("s2-phone");
      const THICK = 46;
      const scr = document.getElementById("s2-screen");
      const base = document.createElement("div");
      base.className = "ph-base";
      base.style.transform = "translateZ(-22px)";
      phone.appendChild(base);
      const body = OrbisPhone.build(phone, { screen: scr, thickness: THICK, screenZ: 0.6, islandZ: 7, glareZ: 8.5 });
      // Page A (pairing entry) and its relief: one depth factor --d (1 = full relief, 0 = flat)
      const pageA = [...scr.children].filter((el) => el.id !== "s2-sheet" && el.id !== "s2-chat");
      pageA.forEach((el) => el.classList.add("s2-pga"));
      scr.style.setProperty("--d", "1");
      phone.querySelectorAll("#s2-screen > .flat, #s2-screen > .scr-bg").forEach((el) => {
        if (!el.style.transform) el.style.transform = "translateZ(0.2px)";
      });
      // Neumorphic relief, lit from the upper left. Each slice carries the light as one continuous gradient
      // (no per-side colours, whose hard corner joins stack into saw teeth), and the slices are dense
      // (~0.6 px apart) so the walls read as one smooth surface rather than a stack of cards. All sizes and depths scale with --d, so the page lands exactly on the flat app.
      const SURF = [230, 235, 244];
      const mixc = (a, b, w) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * w)).join(",")})`;
      // The logo well: the surface rolls over a rounded lip, the wall drops, a fillet meets the floor.
      // Inside a recess the near (top-left) wall is in shade and the far (bottom-right) wall catches the light.
      const WD = 18, NR = 30, LIP = 5, FIL = 4;
      const wellInset = (z) => (z < LIP ? Math.sqrt(LIP * LIP - (LIP - z) * (LIP - z)) : LIP) + (z > WD - FIL ? FIL - Math.sqrt(Math.max(0, FIL * FIL - (z - (WD - FIL)) * (z - (WD - FIL)))) : 0);
      const W_SHADE = [178, 189, 207], W_LIT = [247, 249, 253], FLOOR = [221, 227, 239];
      const bgA = document.getElementById("s2-bgA");
      for (let k = 0; k <= NR; k++) {
        const z = (k / NR) * WD;
        const x = wellInset(z);
        const xn = wellInset(Math.min(WD, ((k + 1) / NR) * WD));
        const steep = z < LIP ? z / LIP : z > WD - FIL ? (WD - z) / FIL : 1;
        const toward = z > WD - FIL ? FLOOR : SURF;
        const shade = mixc(toward, W_SHADE, steep), lit = mixc(toward, W_LIT, steep);
        const r = document.createElement("div");
        r.className = "well-ring s2-pga s2-rl";
        r.style.left = `calc(158.5px + var(--d) * ${x}px)`;
        r.style.top = `calc(323px + var(--d) * ${x}px)`;
        r.style.width = r.style.height = `calc(76px - var(--d) * ${2 * x}px)`;
        r.style.borderRadius = `calc(20px - var(--d) * ${x * 0.6}px)`;
        r.style.padding = `${Math.max(1.6, xn - x + 1.0)}px`;
        r.style.background = `linear-gradient(135deg, ${shade} 0%, ${mixc(toward, [214, 221, 233], steep)} 50%, ${lit} 100%)`;
        r.style.transform = `translateZ(calc(var(--d) * ${-z}px))`;
        scr.insertBefore(r, bgA);
      }
      const floorIn = LIP + FIL;
      const floor = phone.querySelector(".well-floor");
      floor.style.left = floor.style.top = "";
      floor.style.left = `calc(158.5px + var(--d) * ${floorIn}px)`;
      floor.style.top = `calc(323px + var(--d) * ${floorIn}px)`;
      floor.style.width = floor.style.height = `calc(76px - var(--d) * ${2 * floorIn}px)`;
      floor.style.borderRadius = `calc(20px - var(--d) * ${floorIn * 0.6}px)`;
      floor.style.transform = `translateZ(calc(var(--d) * ${-WD}px - 0.4px))`;
      phone.querySelector(".well-mark").style.transform = `translateZ(calc(var(--d) * ${-WD + 0.6}px))`;
      // Raised controls: a pillow that flares out of the surface, stands, and rolls over a rounded top edge.
      const X_LIT = [252, 253, 255], X_SHADE = [172, 184, 203];
      phone.querySelectorAll(".ext").forEach((el) => {
        el.classList.add("p3");
        const D = +el.dataset.depth;
        const R0 = parseFloat(window.getComputedStyle(el).borderRadius) || 16;
        const face = el.querySelector(".xf");
        const N = 28, FLARE = D * 0.45, ROUND = D * 0.42;
        const offAt = (t) => {
          const flare = t < 0.35 ? FLARE * Math.pow(1 - t / 0.35, 2) : 0;
          const u = Math.max(0, (t - 0.55) / 0.45);
          return flare - ROUND * (1 - Math.sqrt(Math.max(0, 1 - u * u)));
        };
        const base = document.createElement("div");
        base.className = "xb";
        base.style.inset = `calc(var(--d) * ${-FLARE}px)`;
        base.style.borderRadius = `calc(${R0}px + var(--d) * ${FLARE}px)`;
        base.style.transform = "translateZ(0.9px)";
        el.insertBefore(base, face);
        for (let k = 0; k < N; k++) {
          const t = k / N;
          const off = offAt(t);
          const u = Math.max(0, (t - 0.55) / 0.45);
          const steep = Math.min(1, t / 0.35) * (1 - 0.6 * u);
          const l = document.createElement("div");
          l.className = "xl s2-rl";
          l.style.inset = `calc(var(--d) * ${-off}px)`;
          l.style.borderRadius = `calc(${R0}px + var(--d) * ${off}px)`;
          // mostly top-lit with a little from the left: top / left rims bright, bottom / right rims in shade
          l.style.background = `linear-gradient(166deg, ${mixc(SURF, X_LIT, steep)} 0%, ${mixc(SURF, [226, 232, 241], steep)} 48%, ${mixc(SURF, X_SHADE, steep)} 100%)`;
          l.style.transform = `translateZ(calc(var(--d) * ${t * D}px + 0.9px))`;
          el.insertBefore(l, face);
        }
        face.style.inset = `calc(var(--d) * ${ROUND}px)`;
        face.style.borderRadius = `calc(${R0}px - var(--d) * ${ROUND * 0.5}px)`;
        face.style.transform = `translateZ(calc(var(--d) * ${D}px + 1.3px))`;
      });

      // Laptop: lid thickness, deck, lip.
      const lid = document.getElementById("s2-lid");
      const lidFront = lid.querySelector(".lid-front");
      for (let k = 1; k <= 6; k++) {
        const l = document.createElement("div");
        l.className = "lid-l lp-leaf";
        l.style.transform = `translateZ(${-2 * k}px)`;
        lid.insertBefore(l, lidFront);
      }
      lid.querySelector(".lid-back").style.transform = "translateZ(-14px) rotateY(180deg)";
      const kbd = document.querySelector("#s2-deck .kbd");
      const rows = [[14, 1], [14, 1], [14, 1], [13, 1], [12, 1], [11, 1]];
      rows.forEach(([count], r) => {
        const kw = (1620 - 24 - (count - 1) * 10) / count;
        for (let c = 0; c < count; c++) {
          const k = document.createElement("div");
          k.className = "key";
          k.style.left = 12 + c * (kw + 10) + "px";
          k.style.top = 12 + r * 103 + "px";
          k.style.width = kw + "px";
          k.style.height = r === 0 ? "60px" : "92px";
          kbd.appendChild(k);
        }
      });
      document.getElementById("s2-host").style.transform = "scale(1.6)";

      // ---------- timeline ----------
      const tl = gsap.timeline({ paused: true });
      gsap.set("#s2-cam", { x: 0, y: 0, z: 0 });
      gsap.set("#s2-orbit", { rotationX: 0, rotationY: 0 });
      // The laptop is never faded: stacked translucent 3D layers sort differently frame to frame and
      // shimmer. It waits fully opaque, out of shot below the frame, and rises in as the camera swings.
      gsap.set("#s2-laptop", { x: 0, y: 2400, z: -1900, visibility: "hidden" });
      gsap.set(".lp-leaf", { opacity: 1 });
      gsap.set("#s2-lid", { rotationX: 12 });
      gsap.set("#s2-deck", { rotationX: 90 });
      gsap.set("#s2-lip", { z: 1320 });
      gsap.set("#s2-phone", { scale: 1.05 });
      gsap.set("#s2-phone-pos", { y: 1180, rotationX: 22 });
      gsap.set("#s2-phone-rot", { rotationX: 0, rotationY: 0 });
      gsap.set("#s2-sheet", { z: 5, y: 852, clipPath: "inset(0px 0px 852px 0px round 55px)", visibility: "visible" });
      gsap.set("#s2-chat", { z: 2.8, opacity: 0, visibility: "hidden" });
      gsap.set(".s2-pga", { visibility: "visible" });
      gsap.set("#s2-banner", { opacity: 0 });
      gsap.set(["#s2-check", "#s2-ptxt"], { opacity: 0 });

      gsap.set(body.glare, { backgroundPosition: "85% 0" });
      gsap.set("#s2-shadow", { opacity: 0, scaleX: 0.6 });
      // 1. the phone rises into the light world
      tl.to("#s2-phone-pos", { y: 0, rotationX: 0, duration: 0.9, ease: "expo.out" }, 0.05);
      tl.to("#s2-shadow", { opacity: 1, scaleX: 1, duration: 0.9, ease: "expo.out" }, 0.05);
      tl.to(body.glare, { backgroundPosition: "62% 0", duration: 0.9, ease: "expo.out" }, 0.05);
      // 2. turn to the side: raised controls stand up, the logo well sinks
      tl.to("#s2-phone-rot", { rotationY: -58, rotationX: 12, duration: 1.0, ease: "power2.inOut" }, 1.2);
      tl.to(body.glare, { backgroundPosition: "18% 0", duration: 1.0, ease: "power2.inOut" }, 1.2);
      tl.to("#s2-shadow", { scaleX: 0.55, x: -40, opacity: 0.7, duration: 1.0, ease: "power2.inOut" }, 1.2);
      tl.to("#s2-cam", { x: -40, y: -130, z: 520, duration: 1.0, ease: "power2.inOut" }, 1.2);
      tl.to("#s2-phone-rot", { rotationY: -63, duration: 0.8, ease: "sine.inOut" }, 2.2);
      // 3. fast-then-slow spin back to the front
      tl.to("#s2-phone-rot", { rotationY: 360, rotationX: 0, duration: 1.25, ease: "expo.out" }, 3.0);
      tl.to("#s2-screen", { "--d": 0, duration: 0.5, ease: "power2.inOut" }, 3.75);
      tl.set(".s2-rl", { visibility: "hidden" }, 4.27);
      tl.fromTo(body.glare, { backgroundPosition: "130% 0" }, { backgroundPosition: "62% 0", duration: 1.25, ease: "expo.out", immediateRender: false }, 3.0);
      tl.to("#s2-shadow", { scaleX: 1, x: 0, opacity: 1, duration: 1.0, ease: "expo.out" }, 3.0);
      tl.to("#s2-shadow", { opacity: 0, duration: 0.6, ease: "power1.in" }, 4.3);
      tl.to("#s2-cam", { x: 0, y: 0, z: 0, duration: 0.9, ease: "power2.inOut" }, 3.0);
      // 4. the camera swings round and pulls back: the phone is aimed at the laptop
      tl.to("#s2-orbit", { rotationY: -50, rotationX: 8, duration: 1.8, ease: "power2.inOut" }, 4.3);
      tl.to("#s2-cam", { x: -650, y: 30, z: -1250, duration: 1.8, ease: "power2.inOut" }, 4.3);
      tl.set("#s2-laptop", { visibility: "visible" }, 4.4);
      tl.to("#s2-laptop", { y: 520, duration: 1.55, ease: "power3.out" }, 4.45);
      tl.to("#s2-orbit", { rotationY: -53, duration: 0.8, ease: "none" }, 6.1);
      // phone opens the scanner sheet
      tl.fromTo("#s2-sheet", { y: 852, clipPath: "inset(0px 0px 852px 0px round 55px)" }, { y: 0, clipPath: "inset(0px 0px 0px 0px round 55px)", duration: 0.4, ease: "expo.out", immediateRender: false }, 4.9);
      // the pairing QR floats up on the Host
      tl.to("#s2-dim", { opacity: 1, duration: 0.3, ease: "power1.out" }, 5.3);
      tl.fromTo("#s2-dialog", { opacity: 0, y: 40, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: "power3.out", immediateRender: false }, 5.35);
      tl.to("#s2-feedqr", { opacity: 1, duration: 0.3, ease: "power1.out" }, 5.55);
      // the chat page waits under the scanner sheet (hidden by it) for the hand-off
      tl.set(".s2-pga", { visibility: "hidden" }, 5.35);
      // 5. recognition without any flash: the detection frame converges on the code (shutter sound),
      //    a banner reports the pairing, the Host trades its code for a check, the sheet glides away
      const LOCK = 5.95;
      tl.fromTo("#s2-lock", { opacity: 0, scale: 1.28 }, { opacity: 1, scale: 1, duration: 0.42, ease: "power2.out", immediateRender: false }, LOCK);
      tl.to("#s2-hint", { opacity: 0, duration: 0.2, ease: "power1.out" }, LOCK + 0.4);
      tl.fromTo("#s2-banner", { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.32, ease: "power3.out", immediateRender: false }, LOCK + 0.45);
      tl.fromTo("#s2-spin", { rotation: 0, transformOrigin: "50% 50%" }, { rotation: 360, transformOrigin: "50% 50%", duration: 0.75, ease: "none", immediateRender: false }, LOCK + 0.45);
      const PAIRED = LOCK + 0.95;
      tl.to("#s2-bn-a", { opacity: 0, duration: 0.18, ease: "power1.in" }, PAIRED);
      tl.to("#s2-bn-b", { opacity: 1, duration: 0.22, ease: "power1.out" }, PAIRED + 0.1);
      tl.to("#s2-dqr", { opacity: 0, scale: 0.9, duration: 0.3, ease: "power2.in" }, PAIRED);
      tl.fromTo("#s2-check", { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: "power3.out", immediateRender: false }, PAIRED + 0.22);
      tl.to("#s2-ptxt", { opacity: 1, duration: 0.3, ease: "power1.out" }, PAIRED + 0.36);
      tl.set("#s2-chat", { opacity: 1, visibility: "visible" }, PAIRED + 0.3);
      tl.to("#s2-sheet", { y: 852, clipPath: "inset(0px 0px 852px 0px round 55px)", duration: 0.65, ease: "power2.inOut" }, PAIRED + 0.35);
      tl.set("#s2-sheet", { visibility: "hidden" }, PAIRED + 1.02);
      // 6. the camera turns back and dives into the phone screen
      tl.to("#s2-orbit", { rotationY: 0, rotationX: 0, duration: 1.1, ease: "power2.inOut" }, 7.45);
      tl.to("#s2-cam", { x: 0, y: 0, z: -300, duration: 0.9, ease: "power2.inOut" }, 7.45);
      tl.to("#s2-cam", { z: 1820, duration: 0.75, ease: "power3.in" }, 8.22);
      tl.to(body.glare, { backgroundPosition: "40% 0", duration: 1.6, ease: "power2.inOut" }, 7.45);

      return { timeline: tl, marks: { LOCK, PAIRED } };
    };

    window.createS3Film = function () {
      const gsap = window.gsap;

      const STEP = 360 / 11;
      const RADIUS = 950;
      const CARD_SCALE = 1.2;
      const REPLY0 = "回弹卡顿是因为每一帧都在重新测量列表高度。我把测量挪到下拉开始时只做一次，回弹交给弹簧动画，主线程不再被占满。";
      const PROMPT = "首页下拉回弹有点卡，帮我看看";
      // Static cards for the other agents (copy is editable here).
      const CARDS = [
        null,
        { kind: "codex", title: "对齐移动端的使用体验", user: "对齐一下移动端的使用体验", tool: ["Edit", "InteractionMotion.swift"], reply: "已对齐两端的返回手势与按钮反馈，iOS 与 Android 共用同一组动效参数。", path: "/Projects/orbis" },
        { kind: "pi", title: "梳理项目中的页面结构", user: "梳理项目中的页面结构", tool: ["Bash", "ls src/pages"], reply: "website 一共 6 个页面：首页、下载、文档、更新日志、隐私和关于。", path: "/Projects/website" },
        { kind: "codex", title: "整理下载页布局", user: "下载页按修改时间排序", tool: ["Edit", "DownloadView.swift"], reply: "已改为按修改时间倒序，最新的文件排在最前。", path: "/Projects/orbis", desk: true },
        { kind: "dsh", title: "检查服务端连接状态", user: "检查服务端连接状态", tool: ["Bash", "curl /health"], reply: "Relay 与局域网链路都正常，端到端加密已启用。", path: "/Projects/orbis" },
        { name: "ZCode", icon: "a-zai" },
        { name: "OpenCode", icon: "a-opencode" },
        { name: "Kimi Code", icon: "a-kimi" },
        { name: "Oh My Pi", icon: "a-omp" },
        { name: "Hermes", icon: "a-hermes" },
        { name: "OpenClaw", icon: "a-openclaw" },
      ];
      const tint = { codex: "var(--codex)", pi: "var(--pi)", dsh: "var(--dsh)" };
      const icon = { codex: "a-codexc", pi: "a-pi", dsh: "a-dsh" };
      const ring = document.getElementById("s3-ring");
      CARDS.forEach((c, i) => {
        if (!c) return;
        const card = document.createElement("div");
        card.className = "card ui";
        card.id = "s3-card" + i;
        const color = c.kind ? tint[c.kind] : "var(--accent)";
        const head = c.kind ? `<i class="agent ${icon[c.kind]}"></i>${c.title}` : `<i class="agent ${c.icon}"></i>${c.name}`;
        const user = c.user || "接着上次的任务继续";
        const reply = c.reply || "好的，正在继续处理。";
        const tool = c.tool ? `<div class="c-tool"><i class="ico i-wrench"></i><b>${c.tool[0]}</b><span class="s3-dynamic-0">${c.tool[1]}</span><span class="s3-dynamic-1">已完成</span></div>` : "";
        const backIcon = c.kind ? icon[c.kind] : c.icon;
        const backName = c.name || (c.desk ? "Codex 桌面版" : c.kind === "dsh" ? "DeepSeek" : c.kind === "pi" ? "Pi" : "Codex");
        card.innerHTML = `<div class="card-back cf"><i class="agent ${backIcon}"></i>${backName}</div><div class="card-face cf">
          <div class="c-btn raised s3-dynamic-2"><i class="ico i-arrow-left"></i></div>
          <div class="c-head">${head}</div>
          <div class="c-status"><span class="dot"></span>运行中</div>
          <div class="c-btn raised s3-dynamic-3"><i class="ico i-history"></i></div>
          <div class="c-btn raised s3-dynamic-4"><i class="ico i-download"></i></div>
          <div class="c-user inset">${user}</div>
          <div class="c-asst">${tool}<div>${reply}</div></div>
          <div class="c-path"><i class="ico i-folder s3-dynamic-5"></i><span class="mono">${c.path || "/Projects"}</span></div>
          <div class="c-clip raised s3-dynamic-6"><i class="ico i-paperclip s3-dynamic-7"></i></div>
          <div class="c-field inset"><span class="s3-dynamic-8">发给 ${c.kind ? (c.kind === "dsh" ? "DeepSeek" : c.kind === "pi" ? "Pi" : "Codex") : c.name}，/ 命令</span></div>
          <div class="c-send raised s3-dynamic-9"><i class="ico i-arrow-up s3-dynamic-10"></i></div>
        </div>`;
        card.style.setProperty('--card-color',color); ring.appendChild(card);
      });
      // Split the live texts into per-character spans.
      const split = (el, text, cls) => {
        el.innerHTML = [...text].map((ch) => `<span class="${cls}">${ch}</span>`).join("");
        return [...el.children];
      };
      const inkChars = split(document.getElementById("s3-c0-reply"), REPLY0, "");
      const termChars = split(document.getElementById("s3-t0-reply"), REPLY0, "ch");
      const typedChars = split(document.getElementById("s3-c0-typed"), PROMPT, "ch");
      const inputChars = split(document.getElementById("s3-t0-input"), PROMPT, "ch");
      const tReplies = [
        null,
        split(document.getElementById("s3-t1-reply"), CARDS[1].reply, "ch"),
        split(document.getElementById("s3-t2-reply"), CARDS[2].reply, "ch"),
        split(document.getElementById("s3-t3-reply"), CARDS[3].reply, "ch"),
        split(document.getElementById("s3-t4-reply"), CARDS[4].reply, "ch"),
      ];

      // ring:begin (generated by scripts/ring_motion.py - edit the constants there)
      const RING = { t0: 6.2, t1: 15.3, total: 33, fps: 120,
        curve: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00001,0.00002,0.00002,0.00002,0.00002,0.00002,0.00002,0.00002,0.00002,0.00003,0.00005,0.00007,0.0001,0.00014,0.00019,0.00025,0.00033,0.00043,0.00054,0.00067,0.00082,0.00098,0.00117,0.00138,0.00161,0.00186,0.00214,0.00244,0.00276,0.00311,0.00348,0.00387,0.00429,0.00473,0.00519,0.00568,0.00618,0.00671,0.00725,0.00782,0.0084,0.009,0.00961,0.01024,0.01088,0.01153,0.01219,0.01285,0.01353,0.01421,0.01489,0.01557,0.01626,0.01694,0.01761,0.01828,0.01895,0.0196,0.02025,0.02088,0.0215,0.0221,0.02269,0.02325,0.0238,0.02433,0.02484,0.02533,0.02579,0.02623,0.02665,0.02704,0.02741,0.02775,0.02807,0.02836,0.02863,0.02887,0.02909,0.02929,0.02946,0.02961,0.02974,0.02986,0.02995,0.03003,0.03009,0.03014,0.03017,0.0302,0.03022,0.03023,0.03023,0.03024,0.03024,0.03024,0.03024,0.03025,0.03025,0.03025,0.03025,0.03025,0.03026,0.03026,0.03026,0.03026,0.03027,0.03027,0.03027,0.03027,0.03028,0.03028,0.03028,0.03028,0.03029,0.03029,0.03029,0.0303,0.0303,0.0303,0.03031,0.03031,0.03031,0.03031,0.03032,0.03032,0.03032,0.03033,0.03033,0.03034,0.03034,0.03034,0.03035,0.03035,0.03035,0.03036,0.03036,0.03037,0.03037,0.03037,0.03038,0.03038,0.03039,0.03039,0.0304,0.0304,0.03041,0.03041,0.03041,0.03042,0.03042,0.03043,0.03043,0.03044,0.03045,0.03045,0.03046,0.03046,0.03047,0.03047,0.03048,0.03048,0.03049,0.0305,0.0305,0.03051,0.03051,0.03052,0.03053,0.03053,0.03054,0.03055,0.03055,0.03056,0.03057,0.03059,0.03061,0.03064,0.03069,0.03076,0.03084,0.03095,0.03108,0.03124,0.03142,0.03164,0.03189,0.03218,0.03249,0.03285,0.03324,0.03367,0.03414,0.03464,0.03518,0.03575,0.03637,0.03701,0.03769,0.03839,0.03913,0.03989,0.04067,0.04147,0.04229,0.04312,0.04397,0.04482,0.04568,0.04653,0.04738,0.04823,0.04906,0.04988,0.05069,0.05147,0.05223,0.05296,0.05366,0.05433,0.05496,0.05556,0.05612,0.05664,0.05712,0.05756,0.05796,0.05832,0.05864,0.05892,0.05917,0.05937,0.05955,0.05969,0.0598,0.05989,0.05996,0.06001,0.06004,0.06007,0.06009,0.06011,0.06012,0.06014,0.06016,0.06018,0.0602,0.06021,0.06023,0.06025,0.06027,0.06029,0.06031,0.06033,0.06035,0.06037,0.06039,0.06041,0.06044,0.06046,0.06048,0.0605,0.06052,0.06055,0.06057,0.06059,0.06062,0.06064,0.06066,0.06069,0.06071,0.06074,0.06076,0.06079,0.06082,0.06084,0.06087,0.0609,0.06092,0.06095,0.06098,0.06101,0.06103,0.06106,0.06109,0.06112,0.06115,0.06118,0.06121,0.06124,0.06128,0.06131,0.06134,0.06137,0.0614,0.06144,0.06147,0.06151,0.06154,0.06157,0.06161,0.06166,0.06172,0.06181,0.06192,0.06207,0.06226,0.06249,0.06278,0.06312,0.06351,0.06397,0.06449,0.06507,0.06571,0.06642,0.06718,0.068,0.06887,0.06979,0.07075,0.07175,0.07278,0.07384,0.0749,0.07598,0.07705,0.07812,0.07917,0.08019,0.08118,0.08213,0.08303,0.08389,0.08468,0.08541,0.08608,0.08668,0.08722,0.08769,0.08809,0.08843,0.08871,0.08894,0.08912,0.08926,0.08936,0.08944,0.08951,0.08957,0.08963,0.08969,0.08976,0.08982,0.08988,0.08995,0.09001,0.09008,0.09014,0.09021,0.09028,0.09035,0.09042,0.09049,0.09056,0.09063,0.0907,0.09077,0.09085,0.09092,0.091,0.09107,0.09115,0.09123,0.09131,0.09139,0.09147,0.09155,0.09163,0.09171,0.0918,0.09188,0.09196,0.09205,0.09214,0.09223,0.09231,0.0924,0.09249,0.09259,0.09268,0.09277,0.09287,0.09297,0.09309,0.09324,0.09345,0.09371,0.09404,0.09445,0.09495,0.09553,0.09622,0.097,0.09787,0.09883,0.09987,0.10099,0.10217,0.10339,0.10465,0.10593,0.1072,0.10847,0.1097,0.11089,0.11201,0.11306,0.11403,0.11491,0.11569,0.11636,0.11694,0.11742,0.11781,0.11813,0.11837,0.11857,0.11872,0.11886,0.119,0.11914,0.11928,0.11942,0.11956,0.11971,0.11985,0.12,0.12015,0.1203,0.12045,0.1206,0.12076,0.12091,0.12107,0.12123,0.12139,0.12155,0.12171,0.12188,0.12205,0.12221,0.12238,0.12255,0.12273,0.1229,0.12308,0.12326,0.12344,0.12362,0.1238,0.12398,0.12417,0.12437,0.1246,0.12488,0.12525,0.12571,0.12629,0.12699,0.12782,0.12879,0.12987,0.13107,0.13237,0.13374,0.13516,0.13661,0.13805,0.13945,0.14079,0.14205,0.1432,0.14423,0.14512,0.14588,0.14651,0.14702,0.14742,0.14775,0.14802,0.14826,0.14851,0.14876,0.14901,0.14926,0.14952,0.14977,0.15003,0.1503,0.15056,0.15083,0.1511,0.15137,0.15164,0.15192,0.1522,0.15248,0.15277,0.15305,0.15334,0.15363,0.15393,0.15423,0.15453,0.15483,0.15513,0.15544,0.15577,0.15615,0.15662,0.15722,0.15796,0.15886,0.15993,0.16115,0.16251,0.16398,0.16552,0.1671,0.16865,0.17015,0.17156,0.17283,0.17395,0.17491,0.1757,0.17634,0.17686,0.17728,0.17767,0.17805,0.17843,0.17882,0.17921,0.17961,0.18,0.1804,0.18081,0.18122,0.18163,0.18204,0.18246,0.18288,0.18331,0.18374,0.18417,0.18461,0.18505,0.1855,0.18594,0.1864,0.18686,0.18738,0.188,0.18878,0.18973,0.19088,0.19221,0.19369,0.19529,0.19695,0.19861,0.2002,0.20168,0.203,0.20413,0.20508,0.20585,0.20649,0.20705,0.20759,0.20813,0.20867,0.20922,0.20978,0.21033,0.2109,0.21146,0.21204,0.21261,0.2132,0.21378,0.21438,0.21497,0.21557,0.21618,0.21679,0.21741,0.21804,0.21876,0.21961,0.22065,0.22189,0.22333,0.22494,0.22664,0.22837,0.23005,0.23161,0.233,0.23418,0.23517,0.236,0.23673,0.23744,0.23815,0.23887,0.2396,0.24033,0.24107,0.24181,0.24256,0.24332,0.24408,0.24485,0.24563,0.24641,0.24719,0.24799,0.24879,0.24966,0.25066,0.25187,0.25328,0.25488,0.25662,0.2584,0.26014,0.26176,0.26319,0.26441,0.26546,0.26639,0.26728,0.26818,0.26909,0.27001,0.27093,0.27186,0.27279,0.27374,0.27469,0.27565,0.27661,0.27759,0.27857,0.27956,0.28061,0.28181,0.2832,0.28479,0.28654,0.28837,0.29017,0.29184,0.29335,0.29466,0.29582,0.29691,0.298,0.2991,0.30021,0.30133,0.30245,0.30359,0.30473,0.30588,0.30704,0.30821,0.30939,0.31059,0.31186,0.3133,0.31492,0.3167,0.31857,0.32041,0.32215,0.32372,0.32512,0.32643,0.32772,0.32902,0.33032,0.33164,0.33297,0.33431,0.33565,0.33701,0.33838,0.33975,0.34114,0.3426,0.3442,0.34596,0.34784,0.34976,0.35162,0.35336,0.35495,0.35646,0.35795,0.35945,0.36096,0.36248,0.36402,0.36556,0.36712,0.36868,0.37026,0.37185,0.37351,0.37529,0.37719,0.37917,0.38113,0.38301,0.38479,0.38649,0.38819,0.38989,0.39161,0.39334,0.39508,0.39683,0.39859,0.40037,0.40216,0.40399,0.40592,0.40793,0.40999,0.41202,0.414,0.41591,0.4178,0.4197,0.42161,0.42354,0.42548,0.42743,0.4294,0.43137,0.43337,0.43541,0.43752,0.43966,0.44182,0.44394,0.44603,0.44812,0.45022,0.45233,0.45446,0.4566,0.45875,0.46092,0.4631,0.4653,0.46754,0.46981,0.47209,0.47437,0.47664,0.47892,0.48121,0.48352,0.48584,0.48818,0.49053,0.4929,0.49528,0.49768,0.5001,0.50253,0.50497,0.50742,0.50989,0.51238,0.51488,0.51739,0.51992,0.52246,0.52502,0.5276,0.53018,0.53279,0.53541,0.53805,0.5407,0.54337,0.54605,0.54875,0.55147,0.5542,0.55695,0.55971,0.5625,0.56529,0.56811,0.57094,0.57379,0.57666,0.57955,0.58245,0.58537,0.58831,0.59126,0.59424,0.59723,0.60024,0.60327,0.60631,0.60938,0.61246,0.61557,0.61869,0.62183,0.62499,0.62817,0.63137,0.63459,0.63783,0.64109,0.64437,0.64767,0.65096,0.65425,0.65754,0.66082,0.66411,0.66739,0.67067,0.67395,0.67722,0.68049,0.68375,0.68701,0.69027,0.69352,0.69676,0.7,0.70323,0.70645,0.70967,0.71288,0.71608,0.71927,0.72245,0.72563,0.72879,0.73195,0.73509,0.73823,0.74135,0.74446,0.74757,0.75066,0.75374,0.7568,0.75986,0.7629,0.76593,0.76894,0.77195,0.77493,0.77791,0.78087,0.78381,0.78674,0.78966,0.79256,0.79544,0.79831,0.80116,0.804,0.80682,0.80962,0.81241,0.81518,0.81793,0.82067,0.82338,0.82608,0.82876,0.83143,0.83407,0.83669,0.8393,0.84189,0.84445,0.847,0.84953,0.85204,0.85453,0.857,0.85945,0.86188,0.86429,0.86667,0.86904,0.87139,0.87371,0.87602,0.8783,0.88056,0.8828,0.88502,0.88722,0.88939,0.89155,0.89368,0.89579,0.89788,0.89994,0.90198,0.90401,0.906,0.90798,0.90993,0.91187,0.91377,0.91566,0.91752,0.91936,0.92118,0.92298,0.92475,0.9265,0.92823,0.92993,0.93161,0.93327,0.9349,0.93652,0.93811,0.93967,0.94122,0.94274,0.94424,0.94571,0.94717,0.9486,0.95,0.95139,0.95275,0.95409,0.95541,0.9567,0.95798,0.95923,0.96045,0.96166,0.96284,0.96401,0.96514,0.96626,0.96736,0.96843,0.96949,0.97052,0.97153,0.97252,0.97349,0.97443,0.97536,0.97627,0.97715,0.97802,0.97886,0.97968,0.98049,0.98127,0.98204,0.98278,0.98351,0.98421,0.9849,0.98557,0.98622,0.98685,0.98746,0.98805,0.98863,0.98919,0.98973,0.99025,0.99076,0.99125,0.99172,0.99218,0.99262,0.99304,0.99345,0.99385,0.99422,0.99459,0.99493,0.99527,0.99558,0.99589,0.99618,0.99646,0.99672,0.99697,0.99721,0.99743,0.99765,0.99785,0.99804,0.99822,0.99839,0.99854,0.99869,0.99883,0.99896,0.99907,0.99918,0.99928,0.99937,0.99946,0.99953,0.9996,0.99966,0.99972,0.99977,0.99981,0.99985,0.99988,0.99991,0.99993,0.99995,0.99996,0.99998,0.99998,0.99999,1,1,1,1,1],
        cross: [[6.962,1],[8.273,2],[9.248,3],[9.968,4],[10.516,5],[10.948,6],[11.301,7],[11.595,8],[11.847,9],[12.065,10],[12.257,0],[12.428,1],[12.582,2],[12.722,3],[12.849,4],[12.967,5],[13.075,6],[13.176,7],[13.27,8],[13.357,9],[13.441,10],[13.518,0],[13.596,1],[13.673,2],[13.753,3],[13.836,4],[13.922,5],[14.015,6],[14.115,7],[14.227,8],[14.357,9],[14.52,10],[14.775,0]],
        land: [[7.248,1],[8.638,2],[9.581,3],[10.233,4]] };
      // ring:end

      const tl = gsap.timeline({ paused: true });
      // Card placement on the ring; the ring centre sits RADIUS behind the front card.
      for (let i = 0; i < 11; i++) {
        const a = (i * STEP * Math.PI) / 180;
        gsap.set("#s3-card" + i, { x: RADIUS * Math.sin(a), z: RADIUS * Math.cos(a), y: 0, rotationY: i * STEP, scale: CARD_SCALE });
        gsap.set("#s3-card" + i + " > .cf", { filter: i === 0 ? "blur(0px)" : "blur(7px)" });
      }
      gsap.set("#s3-ring", { z: -RADIUS, rotationY: 0 });
      gsap.set("#s3-car", { x: -460, y: -60, scale: 3.4 });
      gsap.set("#s3-mon", { x: -1150, filter: "blur(0px)" });
      gsap.set("#s3-world", { scale: 1, opacity: 1 });
      gsap.set(["#s3-c0-user", "#s3-c0-asst", "#s3-c0-tool"], { opacity: 0 });
      gsap.set(inkChars, { opacity: 0, filter: "blur(6px)" });
      gsap.set("#s3-p0", { opacity: 1 });

      // --- 0. arrive from the phone screen: the chat card settles, the computer slides in
      tl.to("#s3-car", { x: 0, y: 0, scale: 1, duration: 1.1, ease: "expo.out" }, 0);
      tl.to("#s3-mon", { x: 0, duration: 0.9, ease: "power3.out" }, 0.3);
      tl.fromTo("#s3-n0", { opacity: 0, filter: "blur(10px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.22, ease: "power2.out", immediateRender: false }, 0.8);

      // --- 1. type on the phone, send; the same words reach the terminal
      typedChars.forEach((c, i) => tl.set(c, { opacity: 1 }, 1.4 + i * 0.05));
      tl.set("#s3-c0-ph", { opacity: 0 }, 1.4);
      tl.to("#s3-c0-send", { scale: 0.88, duration: 0.08, ease: "power2.out" }, 2.25);
      tl.to("#s3-c0-send", { scale: 1, duration: 0.22, ease: "back.out(2)" }, 2.33);
      tl.set("#s3-c0-typed", { opacity: 0 }, 2.33);
      tl.set("#s3-c0-ph", { opacity: 1 }, 2.42);
      // SendFlight: the text leaves the field as a bubble exactly where it was typed, nudges right, then
      // flies up to its place in the transcript and hands over to the real bubble
      const sfBubble = document.getElementById("s3-c0-user");
      const sfFace = sfBubble.parentElement;
      const sfH = sfBubble.offsetHeight;
      const sfX0 = 66 + 14 - 16;
      const sfY0 = 600 + 25 - sfH / 2;
      const sfX1 = sfFace.offsetWidth - 14 - sfBubble.offsetWidth;
      tl.set("#s3-c0-sf", { x: sfX0, y: sfY0, scale: 0.96, opacity: 1, transformOrigin: "0% 50%" }, 2.33);
      tl.to("#s3-c0-sf", { x: sfX0 + 24, duration: 0.1, ease: "power1.out" }, 2.33);
      tl.to("#s3-c0-sf", { x: sfX1, y: 78, scale: 1, duration: 0.48, ease: "power3.inOut" }, 2.43);
      tl.to("#s3-c0-user", { opacity: 1, duration: 0.1, ease: "none" }, 2.86);
      tl.to("#s3-c0-sf", { opacity: 0, duration: 0.12, ease: "none" }, 2.88);
      inputChars.forEach((c, i) => tl.set(c, { opacity: 1 }, 2.4 + i * 0.018));
      tl.set("#s3-t0-input", { opacity: 0 }, 2.72);
      tl.set("#s3-t0-sent", { opacity: 1 }, 2.72);
      tl.set("#s3-t0-think", { opacity: 1 }, 2.76);
      tl.set("#s3-c0-idle", { opacity: 0 }, 2.72);
      tl.set("#s3-c0-run", { opacity: 1 }, 2.72);
      tl.set("#s3-c0-status .dot", { background: "#1B7A57" }, 2.72);
      // --- 2. tool call, then the reply streams on both screens at the same pace
      tl.fromTo("#s3-c0-asst", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.3, ease: "power3.out", immediateRender: false }, 3.25);
      tl.set("#s3-t0-tool", { opacity: 1 }, 3.3);
      tl.to("#s3-c0-tool", { opacity: 1, duration: 0.2, ease: "power1.out" }, 3.35);
      tl.set("#s3-t0-tool2", { opacity: 1 }, 3.48);
      tl.set("#s3-t0-dot", { opacity: 1 }, 3.7);
      const STREAM = 3.72;
      const STAGGER = 0.03;
      termChars.forEach((c, i) => tl.set(c, { opacity: 1 }, STREAM + i * STAGGER));
      inkChars.forEach((c, i) => tl.to(c, { opacity: 1, filter: "blur(0px)", duration: 0.12, ease: "power1.out" }, STREAM + i * STAGGER));
      const streamEnd = STREAM + REPLY0.length * STAGGER + 0.12;
      tl.set("#s3-t0-think", { opacity: 0 }, streamEnd);
      tl.set("#s3-c0-idle", { opacity: 1 }, streamEnd);
      tl.set("#s3-c0-run", { opacity: 0 }, streamEnd);
      tl.set("#s3-c0-status .dot", { background: "#8e97a8" }, streamEnd);

      // --- 3. the ring turns, right to left, along one continuous curve (scripts/ring_motion.py):
      // card by card at first, each move a little quicker than the last, until the stepping melts into
      // a spin; then it slows to a stop seen from above. Names, panes and focus follow the same curve.
      const panes = ["#s3-p0", "#s3-p1", "#s3-p2", "#s3-p3", "#s3-p4", "#s3-p5"];
      let shownPane = 0;
      let shownName = 0;
      const showName = (i, t, quick) => {
        const out = "#s3-n" + shownName;
        const inn = "#s3-n" + i;
        const d = quick ? 0.1 : 0.18;
        tl.to(out, { opacity: 0, y: -46, filter: "blur(8px)", duration: d, ease: "power2.in" }, t);
        tl.fromTo(inn, { opacity: 0, y: 46, filter: "blur(8px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: d, ease: "power2.out", immediateRender: false }, t + d * 0.6);
        shownName = i;
      };
      const showPane = (p, t) => {
        if (p === shownPane) return;
        gsap.set(panes[p], { zIndex: 2 + p });
        tl.to(panes[p], { opacity: 1, duration: 0.12, ease: "power1.out" }, t);
        tl.set(panes[shownPane], { opacity: 0 }, t + 0.12);
        shownPane = p;
      };
      const curve = RING.curve;
      const nC = curve.length - 1;
      const ringEase = (p) => {
        const x = Math.min(nC, Math.max(0, p * nC));
        const i = Math.min(nC - 1, Math.floor(x));
        return curve[i] + (curve[i + 1] - curve[i]) * (x - i);
      };
      tl.to("#s3-ring", { rotationY: -RING.total * STEP, duration: RING.t1 - RING.t0, ease: ringEase }, RING.t0);
      const FOCUS = 5; // the first five cards come into focus one by one; after that everything blurs
      const BLUR_ALL = RING.cross[FOCUS][0];
      let lastName = -1;
      RING.cross.forEach(([t, i], n) => {
        const k = n + 1; // cards travelled
        const gap = RING.cross[n + 1] ? RING.cross[n + 1][0] - t : 1;
        if (k <= FOCUS) {
          tl.to("#s3-card" + ((i + 10) % 11) + " > .cf", { filter: "blur(7px)", duration: 0.32, ease: "power1.in" }, t - 0.16);
          tl.to("#s3-card" + i + " > .cf", { filter: "blur(0px)", duration: 0.32, ease: "power1.out" }, t - 0.08);
          showPane(Math.min(k, 5), t);
          if (tReplies[k]) tReplies[k].forEach((c, j) => tl.set(c, { opacity: 1 }, t + 0.3 + j * 0.025));
        }
        // names keep up while they can still be read, then dissolve into the speed
        if (t < BLUR_ALL + 1.6 && gap >= 0.15) {
          showName(i, t - 0.05, gap < 0.4);
          lastName = n;
        }
      });
      tl.to("#s3-n" + shownName, { opacity: 0, filter: "blur(10px)", duration: 0.3, ease: "power2.in" }, RING.cross[lastName + 1][0]);
      tl.to("#s3-mon", { filter: "blur(16px)", duration: 0.9, ease: "power1.in" }, BLUR_ALL);
      // the far side shows card backs at half size through the gaps: blur them harder so their icons
      // do not pop between frames at speed
      for (let i = 0; i < 11; i++) {
        tl.to("#s3-card" + i + " > .card-face", { filter: "blur(11px)", duration: 0.9, ease: "power1.in" }, BLUR_ALL + 0.05);
        tl.to("#s3-card" + i + " > .card-back", { filter: "blur(26px)", duration: 0.9, ease: "power1.in" }, BLUR_ALL + 0.05);
      }
      const SETTLE = RING.t1;
      // the camera rises over the turntable; the computer slides away
      tl.to("#s3-mon", { x: -1300, opacity: 0, duration: 0.8, ease: "power3.in" }, 13.6);
      tl.to("#s3-stage", { perspectiveOrigin: "960px 560px", duration: 1.5, ease: "power2.inOut" }, 13.8);
      tl.to("#s3-car", { x: -460, y: 175, scale: 0.43, rotationX: -21, duration: 1.5, ease: "power2.inOut" }, 13.8);
      for (let i = 0; i < 11; i++) tl.to("#s3-card" + i + " > .cf", { filter: "blur(0px)", duration: 0.7, ease: "power2.out" }, 14.6);
      // the claim, written in ink above the ring
      const claim = document.getElementById("s3-claim");
      claim.innerHTML = [...claim.textContent.trim()].map((c) => `<span>${c}</span>`).join("");
      [...claim.children].forEach((c, i) => {
        tl.fromTo(c, { opacity: 0, filter: "blur(10px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.22, ease: "power2.out", immediateRender: false }, SETTLE + 0.05 + i * 0.06);
      });
      // fly through the ring into the next scene
      const FLY = 16.85;
      tl.to("#s3-world", { scale: 3.4, filter: "blur(8px)", duration: 0.62, ease: "power3.in" }, FLY);
      tl.to("#s3-world", { opacity: 0, duration: 0.22, ease: "power1.in" }, FLY + 0.42);
      tl.to("#s3-claim", { scale: 2.2, y: -160, filter: "blur(10px)", opacity: 0, duration: 0.5, ease: "power3.in" }, FLY);

      return { timeline: tl, ring: RING, step: STEP, radius: RADIUS };
    };
