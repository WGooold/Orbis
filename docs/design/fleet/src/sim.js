// 模拟电脑上正在发生的事：各 Agent 的任务、流式回复、请求批准、完成
const rnd = (a, b) => a + Math.random() * (b - a);
const split = (s) => { const out = []; let b = ''; for (const c of s) { b += c; if (b.length >= 7 || /[，。；：、]/.test(c) && b.length > 3) { out.push(b); b = ''; } } if (b) out.push(b); return out; };
export class Sim {
  constructor(app) { this.app = app; this.w = app.world; this.askAt = 1e9; this.on = false; }
  begin() {
    this.on = true; const w = this.w; const plan = { claude: 70, kimi: 95, pi: 60, openclaw: 110, codex: 120, opencode: 100, deepseek: 80, hermes: 60 }; let d = 0;
    w.ships.forEach((s) => { const T = plan[s.key]; s.job = null; if (s.key === 'hermes') { s.again = w.t + 11; return; } setTimeout(() => { if (this.on) this.start(s, { dur: T, seed: rnd(.1, .4) }); }, 250 + d * 480); d++; }); this.askAt = w.t + 13; this.askNext = w.byKey.codex || w.ships[0];
  }
  pause() { this.on = false; }
  resume() { if (this.app.ready) this.on = true; }
  start(s, { dur = 30, seed = 0, ask, reply, live } = {}) {
    if (!this.w.online) return; const ss = s.s; if (ask) { ss.title = ask.length > 18 ? ask.slice(0, 18) : ask; ss.log.push({ me: true, t: ask }); ss.full = reply || (ask === s.def.sessions[0].ask ? ss.reply : s.def.any); ss.log.push({ me: false, t: '' }); } else { ss.full = ss.reply; ss.log = [{ me: true, t: ss.ask }, { me: false, t: '' }]; } const chunks = split(ss.full); const n = Math.floor(chunks.length * seed); ss.log[ss.log.length - 1].t = chunks.slice(0, n).join('');
    s.job = { chunks, i: n, next: this.w.t + (live ? 1.5 : 2.5), t0: this.w.t, dur, fly: 0, live: !!live }; this.w.run(s); this.app.ui.state(s);
  }
  stop(s) { s.job = null; this.w.idle(s); this.app.ui.state(s); }
  finish(s) { const j = s.job, l = s.s.log[s.s.log.length - 1]; if (j && l && !l.me) l.t = j.chunks.join(''); s.job = null; // 提前完成时把没说完的话补齐
    this.w.complete(s); this.app.ui.done(s); s.again = this.w.t + rnd(16, 30); }
  approve(s) { s.hold = 0; this.w.approve(s); this.askAt = this.w.t + rnd(34, 52); if (!s.job) { const c = split(s.s.reply); s.job = { chunks: c, i: 0, next: this.w.t + 3, t0: this.w.t, dur: 50, fly: 0 }; } }
  deny(s) { this.w.deny(s); s.job = null; s.again = this.w.t + rnd(14, 24); this.askAt = this.w.t + rnd(34, 52); }
  ask(s) { if (!s || s.state !== 'run') return false; this.w.wait(s); this.app.ui.state(s); return true; }
  step(dt) {
    if (!this.on) return; const w = this.w, app = this.app, t = w.t;
    if (t > this.askAt) { const c = [this.askNext, ...w.ships].filter((s) => s && s.state === 'run' && s.key !== 'pi' && !(app.mode === 'focus' && app.cur() === s && s.job?.live)); if (c.length) this.ask(this.askNext && c.includes(this.askNext) ? this.askNext : c[(Math.random() * c.length) | 0]); this.askNext = null; this.askAt = 1e9; }
    for (const s of w.ships) {
      if (s.state === 'idle' && s.again && t > s.again && !(app.mode === 'focus' && app.cur() === s)) { s.again = 0; this.start(s, { dur: rnd(50, 90) }); }
      const j = s.job; if (!j || s.state !== 'run') continue; const focus = app.mode === 'focus' && app.cur() === s && app.rig.m > .8;
      if (j.i < j.chunks.length && t > j.next && j.fly < 2) { const span = Math.max(.55, (j.dur - (t - j.t0)) / (j.chunks.length - j.i + 1)); const c = j.chunks[j.i++]; const add = () => { if (s.job !== j) return; const l = s.s.log[s.s.log.length - 1]; l.t += c; app.ui.text(s, c); }; if (focus && (j.live || Math.random() < .8)) { j.fly++; w.downlink(s, () => app.unproject(.5, .80, 9), () => { j.fly--; add(); }); j.next = t + (j.live ? rnd(.42, .7) : Math.min(2.4, span)); } else { add(); j.next = t + (j.live ? .6 : span); } }
      if (j.i >= j.chunks.length && !j.fly && t - j.t0 > Math.min(j.dur, j.live ? 4 : 1e9) && t > j.next + .6) this.finish(s);
    }
  }
}
