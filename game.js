'use strict';
// game.js — Last Cans, phase 1: movement, searching, weight, one lift.
(function () {

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const VIEW_W = 11;              // world units visible across the screen width
const PLAYER_R = 0.33;
const STORM_SECONDS = 180;
const STORM_RED_AT = 45;
const LIFT_HOLD = 0.8;          // seconds holding CALL before the countdown starts
const LIFT_COUNTDOWN = 10;
const MAX_WEIGHT = 20;          // weight at which you're barely moving
const PICKUP_R = 0.55;
const REACH = 0.8;              // how close you must be to search a container
const JOY_DEAD = 6, JOY_MAX = 60;
const SNEAK_MAG = 0.42, SPRINT_MAG = 0.8;
const BASE_SPEED = 5.6;         // sprint speed, unloaded, units/sec

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d', { alpha: false });
const ui = {
  hud: $('hud'), timer: $('timer'), packFill: $('pack-fill'), packText: $('pack-text'),
  prompt: $('prompt'), mute: $('mute'),
  btn: { call: $('btn-call'), search: $('btn-search'), swing: $('btn-swing'), throw: $('btn-throw') },
  title: $('screen-title'), result: $('screen-result'), resultTitle: $('result-title'),
  resultBody: $('result-body'), go: $('btn-go'), again: $('btn-again'), titleZone: $('title-zone'),
};

let dpr = 1, W = 1, H = 1, S = 40;   // S = css px per world unit
let vignette = null;                 // cached radial gradient, rebuilt on resize
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  S = W / VIEW_W;
  vignette = null;
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Audio (synthesized, starts on first touch)
// ---------------------------------------------------------------------------
const Sfx = {
  ctx: null, master: null, muted: localStorage.getItem('lc_muted') === '1',
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(this.ctx.destination);
    this.startWind();
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  setMuted(m) {
    this.muted = m; localStorage.setItem('lc_muted', m ? '1' : '0');
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
    ui.mute.textContent = m ? '🔇' : '🔊';
  },
  startWind() {
    const c = this.ctx, len = c.sampleRate * 3;
    const buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
    const g = c.createGain(); g.gain.value = 0.22;
    src.connect(f); f.connect(g); g.connect(this.master); src.start();
    const lfo = c.createOscillator(); lfo.frequency.value = 0.11;
    const lg = c.createGain(); lg.gain.value = 260; lfo.connect(lg); lg.connect(f.frequency); lfo.start();
    this.wind = g;
  },
  tone(freq, dur, type, vol, slideTo) {
    if (!this.ctx) return;
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, c.currentTime);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, c.currentTime + dur);
    g.gain.setValueAtTime(vol || 0.3, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    o.connect(g); g.connect(this.master); o.start(); o.stop(c.currentTime + dur + 0.02);
  },
  noise(dur, vol, freq, q) {
    if (!this.ctx) return;
    const c = this.ctx, n = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq || 1000; f.Q.value = q || 1;
    const g = c.createGain(); g.gain.setValueAtTime(vol || 0.2, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    src.connect(f); f.connect(g); g.connect(this.master); src.start();
  },
  clink() { this.tone(1700 + Math.random() * 400, 0.09, 'triangle', 0.22, 2400); this.tone(3100, 0.05, 'sine', 0.08); },
  heavy() { this.tone(220, 0.25, 'triangle', 0.3, 120); this.noise(0.15, 0.2, 400, 0.8); },
  rummage() { this.noise(0.07, 0.12, 700 + Math.random() * 600, 0.7); },
  found() { this.tone(660, 0.12, 'square', 0.1, 990); },
  beep(hi) { this.tone(hi ? 1320 : 880, 0.12, 'square', 0.15); },
  klaxon() { this.tone(300, 0.6, 'sawtooth', 0.25, 180); this.tone(600, 0.6, 'square', 0.12, 360); },
  liftArrive() { this.tone(440, 0.5, 'sine', 0.25, 880); this.noise(0.6, 0.25, 300, 0.5); },
  swing() { this.noise(0.18, 0.25, 900, 0.5); },
  thud() { this.tone(140, 0.2, 'triangle', 0.3, 60); this.noise(0.12, 0.2, 500, 0.6); },
  thunder() { this.noise(1.6, 0.5, 120, 0.4); this.tone(60, 1.4, 'sine', 0.3, 30); },
  storm() { this.noise(2.5, 0.8, 200, 0.3); },
};
ui.mute.textContent = Sfx.muted ? '🔇' : '🔊';
ui.mute.addEventListener('click', e => { e.preventDefault(); Sfx.init(); Sfx.setMuted(!Sfx.muted); });
const unlockAudio = () => { Sfx.init(); Sfx.resume(); };
window.addEventListener('pointerdown', unlockAudio, { passive: true });
window.addEventListener('touchend', unlockAudio, { passive: true });

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const G = {
  state: 'title', zone: null, player: null, cam: { x: 0, y: 0 }, t: 0, storm: STORM_SECONDS,
  cans: [], floats: [], noises: [], particles: [], thrown: [],
  lift: { active: null, hold: 0, countdown: 0, arrived: false, arriveT: 0, lastBeep: -1 },
  result: null, practice: false, shake: 0, stormHit: false,
};

function newPlayer(x, y) {
  return { x, y, dir: -Math.PI / 2, mode: 'idle', speed: 0, pack: [], weight: 0, value: 0,
    step: 0, search: null, swing: 0, swingCd: 0, noise: 0, frozen: false };
}

function startRun() {
  G.zone = makeTestZone();
  const z = G.zone;
  G.player = newPlayer(z.spawn.x, z.spawn.y);
  G.cam.x = z.spawn.x; G.cam.y = z.spawn.y;
  G.t = 0; G.storm = STORM_SECONDS; G.stormHit = false;
  G.cans = z.cans.map(c => ({ ...c }));
  G.floats = []; G.noises = []; G.particles = []; G.thrown = [];
  G.lift = { active: null, hold: 0, countdown: 0, arrived: false, arriveT: 0, lastBeep: -1 };
  G.result = null; G.shake = 0;
  for (const c of z.containers) { c.searched = false; c.progress = 0; }
  G.state = 'playing';
  ui.title.classList.add('hidden'); ui.result.classList.add('hidden'); ui.hud.classList.remove('hidden');
  ui.timer.classList.remove('red');
}

function endRun(kind, reason) {
  if (G.state !== 'playing') return;
  G.state = kind;
  const p = G.player;
  G.result = { kind, reason, value: p.value, pack: p.pack.slice(), stormLeft: Math.max(0, G.storm), weight: p.weight };
  joy.active = false; searchTouch.id = null;
  for (const k in held) held[k] = false;
  setTimeout(showResult, kind === 'extracted' ? 900 : 1400);
}

function showResult() {
  const r = G.result;
  ui.hud.classList.add('hidden');
  ui.resultTitle.textContent = r.kind === 'extracted' ? 'EXTRACTED' : 'DOWNED';
  ui.resultTitle.classList.toggle('downed', r.kind !== 'extracted');
  const counts = {}; for (const t of r.pack) counts[t] = (counts[t] || 0) + 1;
  const emojiRow = CAN_ORDER.map(t => CANS[t].emoji.repeat(Math.min(counts[t] || 0, 20))).join('');
  let html = '';
  if (r.kind === 'extracted') {
    html += `<div class="big-num">${r.value.toLocaleString()} pts</div>`;
    html += `<div class="cans">${emojiRow || '—'}</div>`;
    for (const t of CAN_ORDER) if (counts[t]) html += `<div class="row"><span>${CANS[t].emoji} ${CANS[t].name} × ${counts[t]}</span><span>${(counts[t] * CANS[t].pts).toLocaleString()}</span></div>`;
    html += `<div class="row"><span>⛈️ Storm time left</span><span>${fmtTime(r.stormLeft)}</span></div>`;
  } else {
    html += `<div class="big-num">0 pts</div>`;
    html += `<div>${r.reason}</div>`;
    if (r.value > 0) html += `<div>You were carrying <b>${r.value.toLocaleString()} pts</b> 💀</div><div class="cans">${emojiRow}</div>`;
  }
  ui.resultBody.innerHTML = html;
  ui.result.classList.remove('hidden');
}

ui.go.addEventListener('click', e => { e.preventDefault(); unlockAudio(); startRun(); });
ui.again.addEventListener('click', e => { e.preventDefault(); unlockAudio(); startRun(); });
ui.titleZone.textContent = 'Test Zone';

function fmtTime(s) { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

// ---------------------------------------------------------------------------
// Input: floating joystick on the canvas, hold buttons in the DOM, keyboard
// for desktop testing.
// ---------------------------------------------------------------------------
const joy = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0, mag: 0 };
const searchTouch = { id: null, c: null };
const held = { call: false, search: false, swing: false, throw: false };
const pressed = { swing: false, throw: false };
const keys = {};

function screenToWorld(sx, sy) { return { x: (sx - W / 2) / S + G.cam.x, y: (sy - H / 2) / S + G.cam.y }; }

canvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (G.state !== 'playing') return;
  // Touching a container you're next to starts a search on that container.
  const w = screenToWorld(e.clientX, e.clientY);
  const c = containerAtPoint(w.x, w.y, 0.25);
  if (c && !c.searched && containerInReach(c) && searchTouch.id === null) {
    searchTouch.id = e.pointerId; searchTouch.c = c; return;
  }
  if (joy.active) return;
  joy.active = true; joy.id = e.pointerId; joy.ox = e.clientX; joy.oy = e.clientY; joy.dx = joy.dy = 0; joy.mag = 0;
}, { passive: false });
canvas.addEventListener('pointermove', e => {
  e.preventDefault();
  if (!joy.active || e.pointerId !== joy.id) return;
  let dx = e.clientX - joy.ox, dy = e.clientY - joy.oy;
  let len = Math.hypot(dx, dy);
  if (len > JOY_MAX) { // the base follows the finger so turning stays responsive
    const over = len - JOY_MAX;
    joy.ox += dx / len * over; joy.oy += dy / len * over;
    dx = dx / len * JOY_MAX; dy = dy / len * JOY_MAX; len = JOY_MAX;
  }
  joy.dx = dx; joy.dy = dy;
  joy.mag = len < JOY_DEAD ? 0 : Math.min(1, (len - JOY_DEAD) / (JOY_MAX - JOY_DEAD));
}, { passive: false });
const endPointer = e => {
  if (joy.active && e.pointerId === joy.id) { joy.active = false; joy.mag = 0; }
  if (searchTouch.id === e.pointerId) { searchTouch.id = null; searchTouch.c = null; }
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', endPointer);
canvas.addEventListener('contextmenu', e => e.preventDefault());

for (const name in ui.btn) {
  const el = ui.btn[name];
  const down = e => { e.preventDefault(); if (el.setPointerCapture) try { el.setPointerCapture(e.pointerId); } catch (_) {} held[name] = true; pressed[name] = true; el.classList.add('held'); };
  const up = e => { e.preventDefault(); held[name] = false; el.classList.remove('held'); };
  el.addEventListener('pointerdown', down, { passive: false });
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  el.addEventListener('contextmenu', e => e.preventDefault());
}

window.addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === 'e') held.search = true;
  if (e.key === ' ') { held.call = true; e.preventDefault(); }
  if (e.key === 'f' && !e.repeat) { pressed.swing = true; }
  if (e.key === 'q' && !e.repeat) { pressed.throw = true; }
});
window.addEventListener('keyup', e => {
  keys[e.key.toLowerCase()] = false;
  if (e.key === 'e') held.search = false;
  if (e.key === ' ') held.call = false;
});
function keyboardJoy() {
  let dx = 0, dy = 0;
  if (keys.a || keys.arrowleft) dx -= 1; if (keys.d || keys.arrowright) dx += 1;
  if (keys.w || keys.arrowup) dy -= 1; if (keys.s || keys.arrowdown) dy += 1;
  if (!dx && !dy) return null;
  const mag = keys.shift ? 1 : (keys.alt || keys.control ? 0.25 : 0.6);
  return { dx, dy, mag };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;

function circleHitsSolid(z, x, y, r) {
  const x0 = Math.floor(x - r), x1 = Math.floor(x + r), y0 = Math.floor(y - r), y1 = Math.floor(y + r);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    if (!z.isSolid(tx, ty)) continue;
    const cx = clamp(x, tx, tx + 1), cy = clamp(y, ty, ty + 1);
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}
function moveCircle(o, dx, dy, r) {
  const z = G.zone;
  const nx = o.x + dx;
  if (!circleHitsSolid(z, nx, o.y, r)) o.x = nx;
  const ny = o.y + dy;
  if (!circleHitsSolid(z, o.x, ny, r)) o.y = ny;
}
function distToRect(px, py, c) {
  const cx = clamp(px, c.x, c.x + c.w), cy = clamp(py, c.y, c.y + c.h);
  return Math.hypot(px - cx, py - cy);
}
function containerInReach(c) { return distToRect(G.player.x, G.player.y, c) <= REACH; }
function containerAtPoint(x, y, pad) {
  for (const c of G.zone.containers) {
    if (x >= c.x - pad && x <= c.x + c.w + pad && y >= c.y - pad && y <= c.y + c.h + pad) return c;
  }
  return null;
}
function nearestContainer() {
  let best = null, bd = REACH;
  for (const c of G.zone.containers) {
    if (c.searched) continue;
    const d = distToRect(G.player.x, G.player.y, c);
    if (d <= bd) { bd = d; best = c; }
  }
  return best;
}
function liftUnderPlayer() {
  const p = G.player;
  for (const l of G.zone.lifts) if (Math.abs(p.x - l.x) < 1.5 && Math.abs(p.y - l.y) < 1.5) return l;
  return null;
}
function addFloat(x, y, text, color, big) { G.floats.push({ x, y, text, color: color || '#fff', t: 0, life: 1.1, big: !!big }); }
function emitNoise(x, y, radius, kind) { G.noises.push({ x, y, r: radius, t: 0, life: 0.6, kind: kind || 'noise' }); }
function burst(x, y, color, n, speed) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = (0.5 + Math.random()) * (speed || 2.5);
    G.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, z: 0.2, vz: 1.5 + Math.random() * 2, t: 0, life: 0.5 + Math.random() * 0.4, color });
  }
}
function lowestCanIndex(pack) {
  let bi = -1, bp = Infinity;
  for (let i = 0; i < pack.length; i++) if (CANS[pack[i]].pts < bp) { bp = CANS[pack[i]].pts; bi = i; }
  return bi;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
function update(dt) {
  G.t += dt;
  if (G.state === 'playing') {
    updateStorm(dt);
    if (G.state === 'playing') updatePlayer(dt);
    if (G.state === 'playing') updateLift(dt);
  }
  updateCans(dt);
  updateThrown(dt);
  for (const f of G.floats) f.t += dt; G.floats = G.floats.filter(f => f.t < f.life);
  for (const n of G.noises) n.t += dt; G.noises = G.noises.filter(n => n.t < n.life);
  for (const p of G.particles) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vz -= 9 * dt; if (p.z < 0) { p.z = 0; p.vz *= -0.3; p.vx *= 0.6; p.vy *= 0.6; } }
  G.particles = G.particles.filter(p => p.t < p.life);
  G.shake = Math.max(0, G.shake - dt * 2);
  // camera
  const p = G.player;
  if (p) {
    const z = G.zone;
    const lookX = p.x + Math.cos(p.dir) * 0.6 * (p.mode === 'idle' ? 0 : 1), lookY = p.y + Math.sin(p.dir) * 0.6 * (p.mode === 'idle' ? 0 : 1);
    const k = 1 - Math.pow(0.001, dt);
    G.cam.x = lerp(G.cam.x, lookX, k); G.cam.y = lerp(G.cam.y, lookY, k);
    const hw = W / S / 2, hh = H / S / 2;
    G.cam.x = clamp(G.cam.x, Math.min(hw, z.w / 2), Math.max(z.w - hw, z.w / 2));
    G.cam.y = clamp(G.cam.y, Math.min(hh, z.h / 2), Math.max(z.h - hh, z.h / 2));
  }
  pressed.swing = false; pressed.throw = false;
}

function updateStorm(dt) {
  const was = G.storm;
  G.storm -= dt;
  if (was > STORM_RED_AT && G.storm <= STORM_RED_AT) { Sfx.thunder(); addFloat(G.player.x, G.player.y - 1.2, 'STORM INCOMING', '#ff6a4a', true); G.shake = 0.6; }
  if (G.storm <= 20 && Math.floor(was) !== Math.floor(G.storm) && Math.floor(G.storm) % 7 === 0) Sfx.thunder();
  if (G.storm <= 0) { G.storm = 0; Sfx.storm(); G.shake = 1.5; G.stormHit = true; endRun('downed', 'The storm hit before you reached a lift.'); }
}

function updatePlayer(dt) {
  const p = G.player, z = G.zone;
  if (p.frozen) { p.mode = 'idle'; p.speed = 0; return; }

  // --- searching ---
  const near = nearestContainer();
  let searching = null;
  if (searchTouch.id !== null && searchTouch.c && !searchTouch.c.searched && containerInReach(searchTouch.c)) searching = searchTouch.c;
  else if (held.search && near) searching = near;

  // --- joystick ---
  let jx = 0, jy = 0, mag = 0;
  const kj = keyboardJoy();
  if (joy.active && joy.mag > 0) { jx = joy.dx; jy = joy.dy; mag = joy.mag; }
  else if (kj) { jx = kj.dx; jy = kj.dy; mag = kj.mag; }
  if (searching && mag > 0 && searchTouch.id === null) searching = null; // moving interrupts a button-search
  if (searching) mag = 0;

  const wf = clamp(p.weight / MAX_WEIGHT, 0, 1);
  const weightMul = 1 - 0.6 * wf;
  let frac = 0, mode = 'idle';
  if (mag > 0) {
    if (mag < SNEAK_MAG) { mode = 'sneak'; frac = 0.22 + 0.16 * (mag / SNEAK_MAG); }
    else if (mag < SPRINT_MAG) { mode = 'walk'; frac = 0.42 + 0.26 * ((mag - SNEAK_MAG) / (SPRINT_MAG - SNEAK_MAG)); }
    else { mode = 'sprint'; frac = 1; }
  }
  const tileMul = z.speedAt(Math.floor(p.x), Math.floor(p.y)) || 1;
  const spd = BASE_SPEED * frac * weightMul * tileMul;
  p.mode = mode; p.speed = spd;
  if (mag > 0) {
    const len = Math.hypot(jx, jy) || 1;
    p.dir = Math.atan2(jy, jx);
    moveCircle(p, jx / len * spd * dt, jy / len * spd * dt, PLAYER_R);
    p.step += spd * dt * 2.2;
  }
  // Movement noise radius (phase 2 machines listen to this).
  p.noise = mode === 'sneak' ? 1.2 : mode === 'walk' ? 3 : mode === 'sprint' ? 6.5 : 0;
  p.noise *= 1 + 0.7 * wf;
  if (mode === 'sprint' && Math.floor(p.step / 2.5) !== Math.floor((p.step - spd * dt * 2.2) / 2.5)) emitNoise(p.x, p.y, p.noise, 'step');

  // --- search progress ---
  if (searching) {
    p.search = searching;
    const before = searching.progress;
    searching.progress = Math.min(1, searching.progress + dt / searching.time);
    if (Math.floor(searching.progress * 10) !== Math.floor(before * 10)) { Sfx.rummage(); if (Math.floor(searching.progress * 5) !== Math.floor(before * 5)) emitNoise(p.x, p.y, 2.5, 'rummage'); }
    if (searching.progress >= 1) finishSearch(searching);
  } else p.search = null;

  // --- pick up loose cans ---
  for (let i = G.cans.length - 1; i >= 0; i--) {
    const c = G.cans[i];
    if (c.z > 0.15) continue;
    if (Math.hypot(c.x - p.x, c.y - p.y) < PICKUP_R + (CANS[c.type].legendary ? 0.3 : 0)) {
      G.cans.splice(i, 1);
      p.pack.push(c.type); p.weight += CANS[c.type].weight; p.value += CANS[c.type].pts;
      addFloat(p.x, p.y - 0.8, '+' + CANS[c.type].pts + ' ' + CANS[c.type].name, CANS[c.type].color, CANS[c.type].legendary);
      if (CANS[c.type].legendary) { Sfx.heavy(); G.shake = 0.3; } else Sfx.clink();
    }
  }

  // --- golf club ---
  p.swingCd = Math.max(0, p.swingCd - dt);
  if (p.swing > 0) p.swing -= dt;
  if (pressed.swing && p.swingCd <= 0) {
    p.swing = 0.32; p.swingCd = 0.45;
    Sfx.swing(); emitNoise(p.x, p.y, 3.5, 'swing');
    // Phase 2: hit machines inside the swing arc here.
  }

  // --- throw lowest can as a distraction ---
  if (pressed.throw && p.pack.length) {
    const i = lowestCanIndex(p.pack);
    const type = p.pack.splice(i, 1)[0];
    p.weight -= CANS[type].weight; p.value -= CANS[type].pts;
    const sp = 9;
    G.thrown.push({ type, x: p.x, y: p.y, z: 0.6, vx: Math.cos(p.dir) * sp, vy: Math.sin(p.dir) * sp, vz: 3.2, t: 0 });
    addFloat(p.x, p.y - 0.8, 'threw ' + CANS[type].name, '#ddd');
  }
}

function finishSearch(c) {
  c.searched = true; c.progress = 1;
  Sfx.found();
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  if (!c.loot.length) { addFloat(cx, c.y - 0.3, 'empty', '#aaa'); return; }
  const z = G.zone;
  c.loot.forEach((type, i) => {
    // scatter onto a walkable spot next to the container, biased toward the player
    let best = null;
    const base = Math.atan2(G.player.y - cy, G.player.x - cx);
    for (let k = 0; k < 12; k++) {
      const a = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.55 + (i * 0.3);
      const r = Math.max(c.w, c.h) / 2 + 0.55 + (i % 3) * 0.25;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (z.walkable(Math.floor(x), Math.floor(y)) && !circleHitsSolid(z, x, y, 0.2)) { best = { x, y }; break; }
    }
    if (!best) best = { x: G.player.x, y: G.player.y };
    G.cans.push({ type, x: cx, y: cy, z: 0.5, vz: 2.5 + i * 0.4, vx: (best.x - cx) * 2.2, vy: (best.y - cy) * 2.2, t: 0, tx: best.x, ty: best.y });
  });
  c.loot = [];
}

function updateCans(dt) {
  for (const c of G.cans) {
    c.t += dt;
    if (c.z > 0 || c.vz > 0) {
      c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt; c.vz -= 9.5 * dt;
      if (c.z <= 0) { c.z = 0; c.vz = 0; c.vx = 0; c.vy = 0; if (c.tx !== undefined) { c.x = c.tx; c.y = c.ty; } Sfx.clink(); }
    }
  }
}

function updateThrown(dt) {
  for (let i = G.thrown.length - 1; i >= 0; i--) {
    const c = G.thrown[i];
    c.t += dt;
    const nx = c.x + c.vx * dt, ny = c.y + c.vy * dt;
    if (G.zone.isSolid(Math.floor(nx), Math.floor(ny))) { c.vx *= -0.2; c.vy *= -0.2; }
    else { c.x = nx; c.y = ny; }
    c.z += c.vz * dt; c.vz -= 9.5 * dt;
    if (c.z <= 0) {
      G.thrown.splice(i, 1);
      Sfx.thud(); emitNoise(c.x, c.y, 8, 'throw');
      burst(c.x, c.y, CANS[c.type].color, 10, 2);
    }
  }
}

function updateLift(dt) {
  const L = G.lift, p = G.player;
  const on = liftUnderPlayer();
  if (L.arrived) {
    L.arriveT += dt;
    if (L.arriveT > 0.9) endRun('extracted', 'lift');
    return;
  }
  if (L.countdown > 0) {
    if (!on || on !== L.active) {
      L.countdown = 0; L.active = null; L.lastBeep = -1;
      addFloat(p.x, p.y - 1, 'LIFT CANCELLED', '#ff8a6a', true);
      return;
    }
    L.countdown -= dt;
    const sec = Math.ceil(L.countdown);
    if (sec !== L.lastBeep) { L.lastBeep = sec; Sfx.beep(sec <= 3); emitNoise(on.x, on.y, 10, 'lift'); }
    if (L.countdown <= 0) {
      L.countdown = 0; L.arrived = true; L.arriveT = 0; p.frozen = true;
      Sfx.liftArrive(); G.shake = 0.4;
    }
    return;
  }
  if (on && held.call) {
    L.hold += dt;
    if (L.hold >= LIFT_HOLD) {
      L.hold = 0; L.active = on; L.countdown = LIFT_COUNTDOWN; L.lastBeep = -1;
      Sfx.klaxon(); emitNoise(on.x, on.y, 16, 'lift'); G.shake = 0.3;
      addFloat(on.x, on.y - 1.6, 'LIFT CALLED', '#9cf79c', true);
    }
  } else L.hold = 0;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const PAL = {
  [T.GROUND]:   ['#8c7b5f', '#86755a', '#927f62'],
  [T.GRASS]:    ['#6f7a44', '#687340', '#75804a'],
  [T.ROAD]:     ['#5a554f', '#565149', '#5e5953'],
  [T.LOT]:      ['#625c55', '#5e5851', '#666059'],
  [T.WALL]:     ['#6a5a4b', '#665646', '#6e5e4f'],
  [T.BRUSH]:    ['#4b6531', '#46602d', '#4f6a36'],
  [T.RUBBLE]:   ['#7f7265', '#7a6d60', '#847769'],
  [T.PLATFORM]: ['#595d60', '#595d60', '#595d60'],
  [T.FLOOR]:    ['#7b6e5c', '#776a58', '#7f7260'],
};

const glowCache = {};
function glowFor(color) {
  if (glowCache[color]) return glowCache[color];
  const g = ctx.createRadialGradient(0, 0, 0.05, 0, 0, 1);
  g.addColorStop(0, color + 'aa'); g.addColorStop(0.5, color + '33'); g.addColorStop(1, color + '00');
  return glowCache[color] = g;
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#2a221c'; ctx.fillRect(0, 0, W, H);
  if (!G.zone) return;

  let shx = 0, shy = 0;
  if (G.shake > 0) { shx = (Math.random() - 0.5) * G.shake * 10; shy = (Math.random() - 0.5) * G.shake * 10; }
  const offX = W / 2 - G.cam.x * S + shx, offY = H / 2 - G.cam.y * S + shy;
  ctx.setTransform(dpr * S, 0, 0, dpr * S, dpr * offX, dpr * offY);

  drawTiles();
  drawDecor();
  for (const l of G.zone.lifts) drawLift(l);
  drawNoises();
  for (const c of G.zone.containers) drawContainer(c);
  for (const c of G.cans) drawCan(c);
  for (const c of G.thrown) drawCan(c);
  drawParticles();
  drawPlayer();
  if (G.lift.arrived) drawLiftCage();

  // screen space
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawAtmosphere();
  drawFloats(offX, offY);
  drawLiftIndicator(offX, offY);
  drawJoystick();
}

function drawTiles() {
  const z = G.zone;
  const x0 = Math.max(0, Math.floor(G.cam.x - W / S / 2) - 1), x1 = Math.min(z.w - 1, Math.ceil(G.cam.x + W / S / 2) + 1);
  const y0 = Math.max(0, Math.floor(G.cam.y - H / S / 2) - 1), y1 = Math.min(z.h - 1, Math.ceil(G.cam.y + H / S / 2) + 1);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    const t = z.tiles[ty * z.w + tx];
    const h = hash2(tx, ty);
    ctx.fillStyle = PAL[t][h < 0.33 ? 0 : h < 0.66 ? 1 : 2];
    ctx.fillRect(tx, ty, 1.01, 1.01);
    switch (t) {
      case T.GROUND:
        if (h < 0.1) { ctx.fillStyle = '#6f6049'; ctx.fillRect(tx + 0.3 + h * 4, ty + 0.5, 0.12, 0.08); }
        else if (h > 0.94) { ctx.strokeStyle = '#746551'; ctx.lineWidth = 0.03; ctx.beginPath(); ctx.moveTo(tx + 0.1, ty + 0.8); ctx.lineTo(tx + 0.5, ty + 0.4); ctx.lineTo(tx + 0.9, ty + 0.5); ctx.stroke(); }
        break;
      case T.GRASS:
        if (h < 0.6) { ctx.strokeStyle = '#86944f'; ctx.lineWidth = 0.05; ctx.beginPath();
          const gx = tx + 0.2 + h * 0.6, gy = ty + 0.2 + (h * 7 % 1) * 0.6;
          ctx.moveTo(gx, gy + 0.2); ctx.lineTo(gx - 0.08, gy - 0.1); ctx.moveTo(gx, gy + 0.2); ctx.lineTo(gx + 0.1, gy - 0.12); ctx.stroke(); }
        break;
      case T.ROAD: case T.LOT:
        if (h > 0.86) { ctx.strokeStyle = '#4a4540'; ctx.lineWidth = 0.035; ctx.beginPath(); ctx.moveTo(tx + 0.1, ty + 0.2); ctx.lineTo(tx + 0.45, ty + 0.55); ctx.lineTo(tx + 0.35, ty + 0.9); ctx.stroke(); }
        else if (h < 0.08) { ctx.fillStyle = '#6a6a50'; ctx.fillRect(tx + 0.4, ty + 0.3, 0.25, 0.2); }
        break;
      case T.WALL: {
        // fake height: lighter top face, dark bottom lip
        ctx.fillStyle = h < 0.5 ? '#8a7866' : '#857362';
        ctx.fillRect(tx + 0.04, ty + 0.04, 0.92, 0.78);
        ctx.fillStyle = '#4b3d31'; ctx.fillRect(tx, ty + 0.82, 1.01, 0.19);
        if (h > 0.7) { ctx.strokeStyle = '#6b5a4a'; ctx.lineWidth = 0.03; ctx.beginPath(); ctx.moveTo(tx + 0.2, ty + 0.1); ctx.lineTo(tx + 0.5, ty + 0.45); ctx.lineTo(tx + 0.4, ty + 0.75); ctx.stroke(); }
        break;
      }
      case T.BRUSH: {
        ctx.fillStyle = '#3e5a2a';
        ctx.beginPath(); ctx.arc(tx + 0.3 + h * 0.3, ty + 0.35, 0.32, 0, 7); ctx.fill();
        ctx.fillStyle = '#5a7a3a';
        ctx.beginPath(); ctx.arc(tx + 0.65 - h * 0.3, ty + 0.65, 0.3, 0, 7); ctx.fill();
        ctx.fillStyle = '#6c8a44';
        ctx.beginPath(); ctx.arc(tx + 0.45, ty + 0.45 + h * 0.2, 0.18, 0, 7); ctx.fill();
        break;
      }
      case T.RUBBLE: {
        ctx.fillStyle = '#6a5e52';
        ctx.fillRect(tx + 0.1 + h * 0.4, ty + 0.15, 0.3, 0.22);
        ctx.fillStyle = '#8f8275';
        ctx.fillRect(tx + 0.5 - h * 0.3, ty + 0.55, 0.26, 0.2);
        ctx.fillStyle = '#5a4e44';
        ctx.fillRect(tx + 0.65, ty + 0.2 + h * 0.3, 0.15, 0.15);
        break;
      }
      case T.FLOOR:
        ctx.strokeStyle = '#6f6350'; ctx.lineWidth = 0.02;
        ctx.strokeRect(tx + 0.02, ty + 0.02, 0.96, 0.96);
        if (h < 0.12) { ctx.fillStyle = '#5e5343'; ctx.fillRect(tx + 0.3, ty + 0.4, 0.3, 0.12); }
        break;
      case T.PLATFORM:
        ctx.strokeStyle = '#46494c'; ctx.lineWidth = 0.03;
        ctx.beginPath();
        for (let k = 0.2; k < 1; k += 0.2) { ctx.moveTo(tx, ty + k); ctx.lineTo(tx + 1, ty + k); ctx.moveTo(tx + k, ty); ctx.lineTo(tx + k, ty + 1); }
        ctx.stroke();
        break;
    }
  }
}

function drawDecor() {
  const hw = W / S / 2 + 2, hh = H / S / 2 + 2;
  for (const d of G.zone.decor) {
    if (Math.abs(d.x - G.cam.x) > hw || Math.abs(d.y - G.cam.y) > hh) continue;
    ctx.fillStyle = d.k === 'dash' ? 'rgba(220,190,90,0.35)' : 'rgba(230,230,210,0.25)';
    ctx.fillRect(d.x, d.y, d.w, d.h);
  }
}

function drawLift(l) {
  const L = G.lift, active = L.active === l && L.countdown > 0;
  // hazard border
  ctx.lineWidth = 0.12;
  ctx.strokeStyle = '#2a2a2a'; ctx.strokeRect(l.x - 1.44, l.y - 1.44, 2.88, 2.88);
  ctx.save(); ctx.beginPath(); ctx.rect(l.x - 1.5, l.y - 1.5, 3, 3); ctx.clip();
  ctx.strokeStyle = '#d9b43a'; ctx.lineWidth = 0.12; ctx.setLineDash([0.35, 0.35]); ctx.lineDashOffset = active ? -(G.t * 2 % 0.7) : 0;
  ctx.strokeRect(l.x - 1.44, l.y - 1.44, 2.88, 2.88); ctx.setLineDash([]);
  ctx.restore();
  // center plate
  ctx.fillStyle = '#4a4e52'; ctx.beginPath(); ctx.arc(l.x, l.y, 0.9, 0, 7); ctx.fill();
  ctx.strokeStyle = '#6d7276'; ctx.lineWidth = 0.05; ctx.stroke();
  // call post light
  const pulse = 0.5 + 0.5 * Math.sin(G.t * (active ? 14 : 3));
  ctx.fillStyle = active ? `rgba(255,${80 + pulse * 60},40,${0.6 + pulse * 0.4})` : `rgba(120,255,140,${0.4 + pulse * 0.4})`;
  ctx.beginPath(); ctx.arc(l.x, l.y - 1.2, 0.14, 0, 7); ctx.fill();
  if (active) {
    ctx.fillStyle = glowFor(active ? '#ff6a3a' : '#7cff8c');
    ctx.save(); ctx.translate(l.x, l.y); ctx.scale(2.2, 2.2); ctx.beginPath(); ctx.arc(0, 0, 1, 0, 7); ctx.fill(); ctx.restore();
    // countdown ring
    const frac = L.countdown / LIFT_COUNTDOWN;
    ctx.strokeStyle = '#ffd04a'; ctx.lineWidth = 0.14;
    ctx.beginPath(); ctx.arc(l.x, l.y, 1.1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); ctx.stroke();
  } else if (L.hold > 0 && liftUnderPlayer() === l) {
    ctx.strokeStyle = '#9cf79c'; ctx.lineWidth = 0.12;
    ctx.beginPath(); ctx.arc(l.x, l.y, 1.1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (L.hold / LIFT_HOLD)); ctx.stroke();
  }
}

function drawLiftCage() {
  const L = G.lift, l = L.active, p = G.player;
  const k = clamp(L.arriveT / 0.6, 0, 1);
  const size = lerp(4, 2.6, k);
  ctx.save(); ctx.translate(l.x, l.y);
  ctx.globalAlpha = 0.3 + 0.7 * k;
  ctx.strokeStyle = '#c9c2b0'; ctx.lineWidth = 0.14;
  ctx.strokeRect(-size / 2, -size / 2, size, size);
  ctx.lineWidth = 0.06;
  ctx.beginPath();
  for (let i = -size / 2 + 0.4; i < size / 2; i += 0.4) { ctx.moveTo(i, -size / 2); ctx.lineTo(i, size / 2); }
  ctx.stroke();
  ctx.fillStyle = `rgba(20,18,16,${0.55 * k})`; ctx.fillRect(-size / 2, -size / 2, size, size);
  ctx.restore();
  void p;
}

function drawContainer(c) {
  const x = c.x, y = c.y, w = c.w, h = c.h, hue = c.hue;
  ctx.save();
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x + 0.06, y + 0.1, w, h);
  switch (c.type) {
    case 'vending': {
      ctx.fillStyle = '#8c3f2a'; roundRect(x + 0.1, y + 0.05, 0.8, 0.9, 0.08); ctx.fill();
      ctx.fillStyle = '#2b2320'; ctx.fillRect(x + 0.18, y + 0.12, 0.5, 0.55);
      ctx.fillStyle = c.searched ? '#1a1512' : '#3f352c'; ctx.fillRect(x + 0.72, y + 0.12, 0.12, 0.3);
      ctx.fillStyle = '#b8552e'; ctx.fillRect(x + 0.18, y + 0.72, 0.64, 0.14);
      if (!c.searched) { ctx.fillStyle = 'rgba(122,211,82,0.5)'; ctx.fillRect(x + 0.22, y + 0.2, 0.42, 0.08); }
      ctx.fillStyle = 'rgba(80,40,20,0.5)'; ctx.fillRect(x + 0.6, y + 0.78, 0.25, 0.15); // rust
      break;
    }
    case 'cooler': {
      ctx.fillStyle = '#c9c2b0'; roundRect(x + 0.08, y + 0.15, 0.84, 0.75, 0.1); ctx.fill();
      ctx.fillStyle = c.searched ? '#4d4a44' : '#dedac9';
      roundRect(x + 0.08, y + 0.08, 0.84, c.searched ? 0.12 : 0.3, 0.08); ctx.fill();
      ctx.fillStyle = 'rgba(140,70,40,0.45)'; ctx.fillRect(x + 0.15, y + 0.6, 0.3, 0.2);
      ctx.fillStyle = '#6a8ab0'; ctx.fillRect(x + 0.62, y + 0.42, 0.18, 0.1);
      break;
    }
    case 'crate': {
      ctx.fillStyle = '#7a5a38'; ctx.fillRect(x + 0.1, y + 0.1, 0.8, 0.8);
      ctx.strokeStyle = '#5a3f24'; ctx.lineWidth = 0.05;
      ctx.strokeRect(x + 0.13, y + 0.13, 0.74, 0.74);
      ctx.beginPath();
      if (c.searched) { ctx.moveTo(x + 0.13, y + 0.5); ctx.lineTo(x + 0.87, y + 0.5); }
      else { ctx.moveTo(x + 0.13, y + 0.13); ctx.lineTo(x + 0.87, y + 0.87); ctx.moveTo(x + 0.87, y + 0.13); ctx.lineTo(x + 0.13, y + 0.87); }
      ctx.stroke();
      if (c.searched) { ctx.fillStyle = '#2a1f14'; ctx.fillRect(x + 0.2, y + 0.2, 0.6, 0.3); }
      break;
    }
    case 'car': {
      const body = hue < 0.33 ? '#6f7f8a' : hue < 0.66 ? '#8a5a4a' : '#9a9279';
      ctx.translate(x + w / 2, y + h / 2);
      if (h > w) ctx.rotate(Math.PI / 2);
      ctx.fillStyle = '#1e1b18';
      [-0.6, 0.6].forEach(dx => { ctx.fillRect(dx - 0.18, -0.55, 0.36, 0.14); ctx.fillRect(dx - 0.18, 0.41, 0.36, 0.14); });
      ctx.fillStyle = body; roundRect(-0.95, -0.42, 1.9, 0.84, 0.18); ctx.fill();
      ctx.fillStyle = c.searched ? '#4a3a30' : '#2a2a2e'; roundRect(-0.45, -0.34, 0.95, 0.68, 0.1); ctx.fill();
      ctx.fillStyle = 'rgba(110,60,30,0.55)'; ctx.fillRect(0.5, -0.3, 0.3, 0.25); ctx.fillRect(-0.85, 0.05, 0.25, 0.3);
      ctx.fillStyle = '#d9d2b0'; ctx.fillRect(0.88, -0.3, 0.07, 0.18); ctx.fillRect(0.88, 0.12, 0.07, 0.18);
      break;
    }
  }
  ctx.restore();
  // search ring + progress
  const inReach = !c.searched && containerInReach(c);
  if (inReach || (c.progress > 0 && !c.searched)) {
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2, r = Math.max(c.w, c.h) / 2 + 0.25;
    ctx.strokeStyle = 'rgba(255,230,160,0.5)'; ctx.lineWidth = 0.05;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
    if (c.progress > 0) {
      ctx.strokeStyle = '#ffd04a'; ctx.lineWidth = 0.12;
      ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * c.progress); ctx.stroke();
    }
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

function drawCanSprite(type, scale) {
  // A dusty slim can in flavor color with a made-up wave logo. Drawn at origin.
  const def = CANS[type];
  ctx.save(); ctx.scale(scale, scale);
  if (def.legendary) {
    ctx.fillStyle = '#d8ccb0'; roundRect(-0.5, -0.36, 1, 0.72, 0.06); ctx.fill();
    ctx.strokeStyle = '#6e604a'; ctx.lineWidth = 0.04; ctx.strokeRect(-0.5, -0.36, 1, 0.72);
    ctx.fillStyle = '#2a6fb0'; ctx.beginPath(); ctx.moveTo(-0.4, 0.05); ctx.quadraticCurveTo(-0.2, -0.25, 0, 0.02); ctx.quadraticCurveTo(0.2, 0.28, 0.4, 0); ctx.lineTo(0.4, 0.2); ctx.lineTo(-0.4, 0.2); ctx.fill();
    ctx.fillStyle = '#7ad352'; ctx.fillRect(-0.4, -0.3, 0.2, 0.12);
    ctx.fillStyle = '#ff7fa8'; ctx.fillRect(-0.15, -0.3, 0.2, 0.12);
    ctx.fillStyle = '#ffa033'; ctx.fillRect(0.1, -0.3, 0.2, 0.12);
    ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(-0.5, 0.25, 1, 0.11);
  } else {
    ctx.fillStyle = def.color; roundRect(-0.14, -0.3, 0.28, 0.6, 0.07); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(-0.09, -0.26, 0.06, 0.5);
    ctx.fillStyle = '#d8d2c0'; ctx.fillRect(-0.14, -0.3, 0.28, 0.07); ctx.fillRect(-0.14, 0.23, 0.28, 0.07);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 0.035;
    ctx.beginPath(); ctx.moveTo(-0.09, 0.02); ctx.quadraticCurveTo(-0.045, -0.1, 0, 0.02); ctx.quadraticCurveTo(0.045, 0.14, 0.09, 0.02); ctx.stroke();
    ctx.fillStyle = 'rgba(60,40,20,0.3)'; ctx.fillRect(0.02, 0.1, 0.1, 0.09); // dust
    ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(-0.14, 0.12, 0.08, 0.06); // dent
  }
  ctx.restore();
}

function drawCan(c) {
  const def = CANS[c.type];
  ctx.save();
  ctx.translate(c.x, c.y);
  // ground shadow
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath(); ctx.ellipse(0, 0.18, def.legendary ? 0.5 : 0.17, 0.08, 0, 0, 7); ctx.fill();
  if (def.glow || def.legendary) {
    const pulse = def.legendary ? 0.8 + 0.35 * Math.sin(G.t * 4) : 0.9;
    ctx.save(); ctx.scale(pulse, pulse); ctx.fillStyle = glowFor(def.color); ctx.beginPath(); ctx.arc(0, 0, 1, 0, 7); ctx.fill(); ctx.restore();
  } else {
    ctx.save(); ctx.scale(0.5, 0.5); ctx.fillStyle = glowFor(def.color); ctx.beginPath(); ctx.arc(0, 0, 1, 0, 7); ctx.fill(); ctx.restore();
  }
  ctx.translate(0, -c.z);
  ctx.rotate(def.legendary ? 0 : Math.sin(c.t * 0.7 + c.x) * 0.3 + (c.z > 0 ? c.t * 10 : 0));
  drawCanSprite(c.type, 1);
  ctx.restore();
}

function drawPlayer() {
  const p = G.player, wf = clamp(p.weight / MAX_WEIGHT, 0, 1);
  ctx.save(); ctx.translate(p.x, p.y);
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(0.04, 0.12, 0.36, 0.22, 0, 0, 7); ctx.fill();
  ctx.rotate(p.dir);
  const bob = p.mode === 'idle' ? 0 : Math.sin(p.step * 2) * 0.05;
  // legs
  const stride = p.mode === 'idle' ? 0 : Math.sin(p.step * 2) * 0.18;
  ctx.fillStyle = '#3a3228';
  ctx.fillRect(-0.05 + stride, -0.22, 0.26, 0.12);
  ctx.fillRect(-0.05 - stride, 0.1, 0.26, 0.12);
  // backpack (behind the body, i.e. negative x since we face +x)
  const packH = 0.44 + 0.22 * wf, packW = 0.36 + 0.14 * wf;
  ctx.fillStyle = '#5c4a32'; roundRect(-0.42 - 0.1 * wf, -packH / 2, packW, packH, 0.08); ctx.fill();
  ctx.fillStyle = '#8a6a3a';
  const fillH = packH * 0.9 * wf;
  ctx.fillRect(-0.42 - 0.1 * wf + 0.04, packH / 2 - 0.04 - fillH, packW - 0.08, fillH);
  // can tops poking out of the pack
  const show = Math.min(p.pack.length, 5);
  for (let i = 0; i < show; i++) { ctx.fillStyle = CANS[p.pack[p.pack.length - 1 - i]].color; ctx.fillRect(-0.38 - 0.1 * wf + i * 0.06, -packH / 2 - 0.05, 0.05, 0.08); }
  // body (jacket)
  ctx.fillStyle = '#9a7c52'; ctx.beginPath(); ctx.ellipse(0 + bob, 0, 0.3, 0.34, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#7d6240'; ctx.fillRect(-0.1 + bob, -0.3, 0.12, 0.6);
  // arms
  ctx.fillStyle = '#b08a5c';
  ctx.beginPath(); ctx.arc(0.1 + bob, -0.32, 0.09, 0, 7); ctx.fill();
  // golf club: held low on the right side, swings in an arc out front
  const sw = p.swing > 0 ? (1 - p.swing / 0.32) : 0;
  const ang = p.swing > 0 ? lerp(-1.6, 1.2, easeOut(sw)) : 0.9;
  ctx.save(); ctx.translate(0.1 + bob, 0.3);
  ctx.rotate(ang);
  drawGolfClub();
  ctx.restore();
  if (p.swing > 0) {
    ctx.strokeStyle = `rgba(255,240,200,${0.5 * (1 - sw)})`; ctx.lineWidth = 0.1;
    ctx.beginPath(); ctx.arc(0.1, 0.3, 0.95, -1.6, lerp(-1.6, 1.2, easeOut(sw))); ctx.stroke();
  }
  ctx.fillStyle = '#b08a5c';
  ctx.beginPath(); ctx.arc(0.1 + bob, 0.3, 0.09, 0, 7); ctx.fill();
  // head + hood
  ctx.fillStyle = '#6b5438'; ctx.beginPath(); ctx.arc(0.06 + bob, 0, 0.2, 0, 7); ctx.fill();
  ctx.fillStyle = '#c9a57a'; ctx.beginPath(); ctx.arc(0.12 + bob, 0, 0.12, 0, 7); ctx.fill();
  ctx.fillStyle = '#3a2d22'; ctx.fillRect(0.14 + bob, -0.08, 0.1, 0.16); // goggles
  ctx.restore();

  // noise ring while sprinting/heavy
  if (p.noise > 3 && p.mode !== 'idle') {
    const k = (G.t * 1.5) % 1;
    ctx.strokeStyle = `rgba(255,255,255,${0.18 * (1 - k)})`; ctx.lineWidth = 0.05;
    ctx.beginPath(); ctx.arc(p.x, p.y, 0.6 + k * p.noise * 0.6, 0, 7); ctx.stroke();
  }
}
function easeOut(t) { return 1 - (1 - t) * (1 - t); }

// A driver seen from above: rubber grip, steel shaft, hosel bend, and a
// rounded club head set off to one side of the shaft end.
function drawGolfClub() {
  ctx.lineCap = 'round';
  // shaft (with a thin dark edge so it reads against light ground)
  ctx.strokeStyle = '#3a3a3e'; ctx.lineWidth = 0.075;
  ctx.beginPath(); ctx.moveTo(0.05, 0); ctx.lineTo(0.78, 0); ctx.stroke();
  ctx.strokeStyle = '#c9ccd2'; ctx.lineWidth = 0.045;
  ctx.beginPath(); ctx.moveTo(0.05, 0); ctx.lineTo(0.78, 0); ctx.stroke();
  // grip
  ctx.strokeStyle = '#1c1816'; ctx.lineWidth = 0.1;
  ctx.beginPath(); ctx.moveTo(-0.08, 0); ctx.lineTo(0.22, 0); ctx.stroke();
  ctx.strokeStyle = '#4a4440'; ctx.lineWidth = 0.025;
  ctx.beginPath(); ctx.moveTo(-0.02, -0.02); ctx.lineTo(0.18, -0.02); ctx.stroke();
  // hosel: shaft bends down into the head
  ctx.strokeStyle = '#c9ccd2'; ctx.lineWidth = 0.045;
  ctx.beginPath(); ctx.moveTo(0.78, 0); ctx.quadraticCurveTo(0.86, 0, 0.88, 0.08); ctx.stroke();
  // head: a rounded driver head angled off the shaft
  ctx.save(); ctx.translate(0.88, 0.12); ctx.rotate(0.35); ctx.scale(0.78, 0.78);
  ctx.fillStyle = '#2b2d33';
  ctx.beginPath(); ctx.ellipse(0, 0, 0.21, 0.13, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#4c5058';
  ctx.beginPath(); ctx.ellipse(-0.02, -0.03, 0.15, 0.08, 0, 0, 7); ctx.fill();
  // face: a flat lighter edge on the striking side
  ctx.strokeStyle = '#d8dbe0'; ctx.lineWidth = 0.035;
  ctx.beginPath(); ctx.moveTo(-0.17, -0.12); ctx.lineTo(0.19, -0.1); ctx.stroke();
  // grooves
  ctx.strokeStyle = '#8a8e96'; ctx.lineWidth = 0.015;
  ctx.beginPath(); ctx.moveTo(-0.12, -0.08); ctx.lineTo(0.14, -0.07); ctx.moveTo(-0.1, -0.05); ctx.lineTo(0.12, -0.04); ctx.stroke();
  ctx.restore();
}

function drawNoises() {
  for (const n of G.noises) {
    const k = n.t / n.life;
    ctx.strokeStyle = n.kind === 'lift' ? `rgba(255,120,60,${0.5 * (1 - k)})` : `rgba(255,255,255,${0.35 * (1 - k)})`;
    ctx.lineWidth = 0.06;
    ctx.beginPath(); ctx.arc(n.x, n.y, 0.3 + n.r * easeOut(k), 0, 7); ctx.stroke();
  }
}

function drawParticles() {
  for (const p of G.particles) {
    ctx.globalAlpha = 1 - p.t / p.life;
    ctx.fillStyle = p.color; ctx.fillRect(p.x - 0.05, p.y - p.z - 0.05, 0.1, 0.1);
  }
  ctx.globalAlpha = 1;
}

function drawAtmosphere() {
  // hazy daylight that reddens as the storm closes in
  const k = clamp(1 - G.storm / STORM_RED_AT, 0, 1);
  if (G.stormHit) { ctx.fillStyle = 'rgba(40,10,10,0.6)'; ctx.fillRect(0, 0, W, H); }
  ctx.fillStyle = `rgba(${Math.round(lerp(255, 200, k))},${Math.round(lerp(210, 50, k))},${Math.round(lerp(140, 30, k))},${lerp(0.06, 0.22, k)})`;
  ctx.fillRect(0, 0, W, H);
  if (!vignette) {
    vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    vignette.addColorStop(0, 'rgba(0,0,0,0)'); vignette.addColorStop(1, 'rgba(10,5,0,0.55)');
  }
  ctx.fillStyle = vignette; ctx.fillRect(0, 0, W, H);
  if (k > 0 && Math.random() < 0.004 * k) { ctx.fillStyle = 'rgba(255,230,220,0.25)'; ctx.fillRect(0, 0, W, H); }
}

function drawFloats(offX, offY) {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const f of G.floats) {
    const k = f.t / f.life;
    ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
    ctx.font = (f.big ? '800 18px' : '700 14px') + ' -apple-system, Helvetica, Arial, sans-serif';
    const sx = f.x * S + offX, sy = (f.y - k * 0.9) * S + offY;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.strokeText(f.text, sx, sy);
    ctx.fillStyle = f.color; ctx.fillText(f.text, sx, sy);
  }
  ctx.globalAlpha = 1;
}

function drawLiftIndicator(offX, offY) {
  const p = G.player; if (!p) return;
  for (const l of G.zone.lifts) {
    const d = Math.hypot(l.x - p.x, l.y - p.y);
    if (d > 26) continue;
    const sx = l.x * S + offX, sy = l.y * S + offY;
    const margin = 28;
    if (sx > margin && sx < W - margin && sy > margin + 60 && sy < H - margin) continue; // on screen
    const cx = W / 2, cy = H / 2;
    const dx = sx - cx, dy = sy - cy;
    const tx = (W / 2 - margin) / Math.abs(dx || 1e-6), ty = (H / 2 - margin - 40) / Math.abs(dy || 1e-6);
    const t = Math.min(tx, ty);
    const ex = cx + dx * t, ey = cy + dy * t;
    const a = Math.atan2(dy, dx);
    ctx.save(); ctx.translate(ex, ey); ctx.rotate(a);
    ctx.fillStyle = 'rgba(140,255,160,0.9)';
    ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -10); ctx.lineTo(-4, 0); ctx.lineTo(-8, 10); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.font = '700 12px -apple-system, Helvetica, Arial, sans-serif'; ctx.fillStyle = 'rgba(140,255,160,0.9)';
    ctx.textAlign = 'center'; ctx.fillText('LIFT ' + Math.round(d) + 'm', ex - Math.cos(a) * 24, ey - Math.sin(a) * 24 + 4);
  }
}

function drawJoystick() {
  if (!joy.active) return;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(joy.ox, joy.oy, JOY_MAX, 0, 7); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath(); ctx.arc(joy.ox, joy.oy, JOY_MAX * SNEAK_MAG, 0, 7); ctx.stroke();
  ctx.fillStyle = joy.mag >= SPRINT_MAG ? 'rgba(255,170,90,0.7)' : joy.mag < SNEAK_MAG ? 'rgba(160,220,255,0.6)' : 'rgba(255,255,255,0.55)';
  ctx.beginPath(); ctx.arc(joy.ox + joy.dx, joy.oy + joy.dy, 22, 0, 7); ctx.fill();
}

// ---------------------------------------------------------------------------
// HUD (DOM)
// ---------------------------------------------------------------------------
const hudCache = {};
function setText(el, key, text) { if (hudCache[key] !== text) { hudCache[key] = text; el.textContent = text; } }
function show(el, key, on) { if (hudCache[key] !== on) { hudCache[key] = on; el.classList.toggle('hidden', !on); } }
function updateHud() {
  const p = G.player; if (!p) return;
  setText(ui.timer, 'timer', fmtTime(G.storm));
  if (G.storm <= STORM_RED_AT) ui.timer.classList.add('red');
  const wf = clamp(p.weight / MAX_WEIGHT, 0, 1);
  const wpct = Math.round(wf * 100) + '%';
  if (hudCache.w !== wpct) { hudCache.w = wpct; ui.packFill.style.width = wpct; }
  setText(ui.packText, 'pack', `${p.value.toLocaleString()} pts · ${p.pack.length} can${p.pack.length === 1 ? '' : 's'} · ${p.mode === 'sneak' ? 'sneaking' : p.mode === 'sprint' ? 'SPRINTING' : p.mode === 'walk' ? 'walking' : 'still'}${wf > 0.6 ? ' · HEAVY' : ''}`);
  const near = nearestContainer(), onLift = liftUnderPlayer();
  show(ui.btn.search, 'bSearch', !!near && G.state === 'playing');
  show(ui.btn.call, 'bCall', !!onLift && G.lift.countdown <= 0 && !G.lift.arrived && G.state === 'playing');
  show(ui.btn.throw, 'bThrow', p.pack.length > 0 && G.state === 'playing');
  let prompt = '';
  if (G.state === 'playing') {
    if (G.lift.arrived) prompt = 'Lift here. Going down…';
    else if (G.lift.countdown > 0) prompt = `Lift arriving in ${Math.ceil(G.lift.countdown)} — stay on the platform!`;
    else if (onLift) prompt = 'Hold CALL to call the lift';
    else if (p.search) prompt = `Searching ${CONTAINER_TYPES[p.search.type].label.toLowerCase()}…`;
    else if (near) prompt = `Hold SEARCH — ${CONTAINER_TYPES[near.type].label.toLowerCase()}`;
  }
  setText(ui.prompt, 'prompt', prompt);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  update(dt);
  render();
  updateHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Debug hooks for the console.
window.LC = { G, startRun, endRun, Sfx };
})();
