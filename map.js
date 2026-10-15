'use strict';
// map.js — tiles, loot definitions, the Zone container, and the hand-made
// phase-1 test zone. Phase 3 replaces makeTestZone() with seeded generation.

const T = { GROUND: 0, GRASS: 1, ROAD: 2, LOT: 3, WALL: 4, BRUSH: 5, RUBBLE: 6, PLATFORM: 7, FLOOR: 8 };

// solid = blocks movement, opaque = blocks sight (used by machines in phase 2)
const TILE_INFO = [
  { solid: false, opaque: false, speed: 1.0 },   // GROUND
  { solid: false, opaque: false, speed: 0.95 },  // GRASS
  { solid: false, opaque: false, speed: 1.05 },  // ROAD
  { solid: false, opaque: false, speed: 1.05 },  // LOT
  { solid: true,  opaque: true,  speed: 0 },     // WALL
  { solid: false, opaque: true,  speed: 0.55 },  // BRUSH
  { solid: false, opaque: false, speed: 0.7 },   // RUBBLE
  { solid: false, opaque: false, speed: 1.0 },   // PLATFORM
  { solid: false, opaque: false, speed: 1.0 },   // FLOOR
];

const CANS = {
  lime:       { name: 'Lime',            pts: 10,  weight: 1.0, color: '#7ad352', dark: '#3f7a2a', emoji: '🟢', tier: 'Common' },
  grapefruit: { name: 'Grapefruit',      pts: 25,  weight: 1.0, color: '#ff7fa8', dark: '#9c3a5c', emoji: '🩷', tier: 'Uncommon' },
  mango:      { name: 'Mango',           pts: 50,  weight: 1.2, color: '#ffa033', dark: '#9c5a14', emoji: '🧡', tier: 'Rare' },
  cherry:     { name: 'Black Cherry',    pts: 100, weight: 1.5, color: '#b05cff', dark: '#4e2a80', emoji: '🟣', tier: 'Epic', glow: true },
  pack:       { name: 'Variety 12-Pack', pts: 400, weight: 10,  color: '#e2d6bd', dark: '#7a6a50', emoji: '📦', tier: 'Legendary', glow: true, legendary: true },
};
const CAN_ORDER = ['lime', 'grapefruit', 'mango', 'cherry', 'pack'];

const CONTAINER_TYPES = {
  vending: { w: 1, h: 1, time: 3.0, label: 'Vending machine' },
  cooler:  { w: 1, h: 1, time: 2.0, label: 'Dead cooler' },
  crate:   { w: 1, h: 1, time: 1.5, label: 'Supply crate' },
  car:     { w: 2, h: 1, time: 2.5, label: 'Wrecked car' },
};

// Deterministic per-tile hash in [0,1) — used for visual variation.
function hash2(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

class Zone {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.tiles = new Uint8Array(w * h);
    this.solid = new Uint8Array(w * h);
    this.containers = [];
    this.cans = [];
    this.lifts = [];
    this.machines = [];
    this.decor = [];
    this.spawn = { x: 1.5, y: 1.5 };
    this.name = '';
  }
  inb(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  get(x, y) { return this.inb(x, y) ? this.tiles[y * this.w + x] : T.WALL; }
  set(x, y, t) {
    if (!this.inb(x, y)) return;
    this.tiles[y * this.w + x] = t;
    this.solid[y * this.w + x] = TILE_INFO[t].solid ? 1 : 0;
  }
  isSolid(x, y) { return this.inb(x, y) ? this.solid[y * this.w + x] === 1 : true; }
  isOpaque(x, y) { return this.inb(x, y) ? (TILE_INFO[this.tiles[y * this.w + x]].opaque || this.solid[y * this.w + x] === 1) : true; }
  speedAt(x, y) { return this.inb(x, y) ? TILE_INFO[this.tiles[y * this.w + x]].speed : 0; }
  fill(x0, y0, x1, y1, t) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, t);
  }
  // Mark a rect solid without changing the tile type (used for containers).
  block(x0, y0, w, h, on) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      if (this.inb(x, y)) this.solid[y * this.w + x] = on ? 1 : 0;
    }
  }
  addContainer(type, x, y, loot, opts) {
    const def = CONTAINER_TYPES[type];
    const rot = !!(opts && opts.rot);
    const c = {
      id: this.containers.length, type, x, y,
      w: rot ? def.h : def.w, h: rot ? def.w : def.h,
      time: def.time, loot: loot.slice(), searched: false, progress: 0,
      hue: (opts && opts.hue !== undefined) ? opts.hue : hash2(x * 7, y * 13),
    };
    this.block(x, y, c.w, c.h, true);
    this.containers.push(c);
    return c;
  }
  addCan(type, x, y) {
    this.cans.push({ type, x, y, z: 0, vz: 0, vx: 0, vy: 0, t: 0 });
  }
  addLift(cx, cy) {
    this.fill(cx - 1, cy - 1, cx + 1, cy + 1, T.PLATFORM);
    this.lifts.push({ x: cx + 0.5, y: cy + 0.5, id: this.lifts.length });
  }
  addMachine(kind, x, y, waypoints) {
    this.machines.push({ kind, x, y, waypoints: waypoints || [] });
  }
  // Lightweight walkability test used by can scatter + validation later.
  walkable(x, y) { return this.inb(x, y) && !this.isSolid(x, y); }
}

// ---------------------------------------------------------------------------
// Hand-made phase-1 test zone: a road running north, a ruined store, a gas
// station, a parking lot of wrecks, a highway overpass, and one lift up north.
// ---------------------------------------------------------------------------
function makeTestZone() {
  const z = new Zone(40, 64);
  z.name = 'Test Zone';
  z.fill(0, 0, 39, 63, T.GROUND);

  // Overgrown blobs of grass across the open ground.
  for (let y = 0; y < z.h; y++) for (let x = 0; x < z.w; x++) {
    const blob = hash2(x >> 2, y >> 2);
    const fine = hash2(x + 100, y + 100);
    if (blob < 0.38 && fine < 0.85) z.set(x, y, T.GRASS);
  }

  // Roads.
  z.fill(18, 0, 21, 63, T.ROAD);            // main N–S road
  z.fill(0, 30, 39, 33, T.ROAD);            // cross street
  for (let y = 1; y < 63; y += 2) if (y < 29 || y > 34) z.decor.push({ k: 'dash', x: 19.9, y: y + 0.2, w: 0.2, h: 1.1 });
  for (let x = 1; x < 39; x += 2) if (x < 17 || x > 22) z.decor.push({ k: 'dash', x: x + 0.2, y: 31.9, w: 1.1, h: 0.2 });

  // Highway overpass: a thick wall band with an underpass for the road and a
  // crumbled gap on the west side.
  z.fill(0, 13, 39, 18, T.RUBBLE);
  z.fill(0, 14, 39, 17, T.WALL);
  z.fill(17, 14, 22, 17, T.ROAD);           // underpass
  z.fill(5, 14, 6, 17, T.RUBBLE);           // collapsed section
  z.fill(31, 14, 31, 17, T.RUBBLE);         // another crack through

  // Ruined store (south-west of the cross street).
  z.fill(4, 40, 14, 50, T.WALL);
  z.fill(5, 41, 13, 49, T.FLOOR);
  z.set(9, 50, T.FLOOR); z.set(10, 50, T.FLOOR);   // doorway facing south
  z.fill(14, 44, 14, 46, T.RUBBLE);                // collapsed east wall
  z.fill(7, 45, 9, 45, T.RUBBLE);                  // fallen shelving
  z.addContainer('vending', 5, 41, ['lime', 'lime', 'grapefruit']);
  z.addContainer('cooler', 12, 41, ['grapefruit', 'mango']);
  z.addContainer('crate', 11, 47, ['lime', 'lime']);
  z.addContainer('crate', 5, 48, ['grapefruit']);

  // Gas station (east of the road, north of the parking lot).
  z.fill(27, 36, 36, 41, T.WALL);
  z.fill(28, 37, 35, 40, T.FLOOR);
  z.set(31, 41, T.FLOOR); z.set(32, 41, T.FLOOR);  // door facing the pumps
  z.fill(24, 43, 37, 47, T.LOT);                   // forecourt
  z.set(24, 43, T.WALL); z.set(37, 43, T.WALL); z.set(24, 47, T.WALL); z.set(37, 47, T.WALL); // canopy pillars
  z.set(28, 45, T.WALL); z.set(33, 45, T.WALL);    // pumps
  z.addContainer('vending', 26, 42, ['lime', 'grapefruit', 'grapefruit']);
  z.addContainer('vending', 36, 42, ['mango', 'lime']);
  z.addContainer('cooler', 29, 38, ['mango', 'mango', 'grapefruit']);
  z.addContainer('vending', 34, 38, ['cherry', 'lime']);

  // Parking lot of wrecks (south-east).
  z.fill(23, 49, 38, 61, T.LOT);
  for (let x = 24; x <= 36; x += 3) z.decor.push({ k: 'line', x: x + 2.9, y: 50, w: 0.12, h: 3 });
  for (let x = 24; x <= 36; x += 3) z.decor.push({ k: 'line', x: x + 2.9, y: 55, w: 0.12, h: 3 });
  const lotCars = [
    [24, 51, ['lime']], [27, 51, []], [30, 51, ['lime', 'lime']], [33, 51, ['grapefruit']], [36, 51, ['lime']],
    [24, 56, ['grapefruit', 'lime']], [30, 56, []], [36, 56, ['mango']],
    [26, 59, ['lime']], [33, 59, ['lime', 'grapefruit']],
  ];
  for (const [x, y, loot] of lotCars) z.addContainer('car', x, y, loot);

  // Wrecks on the road itself.
  z.addContainer('car', 19, 44, ['lime'], { rot: true });
  z.addContainer('car', 20, 22, ['grapefruit', 'grapefruit'], { rot: true });
  z.addContainer('car', 12, 31, ['lime']);
  z.addContainer('car', 28, 32, ['mango']);

  // Brush and rubble to break up the open ground.
  z.fill(2, 20, 8, 24, T.BRUSH);
  z.fill(10, 24, 13, 27, T.BRUSH);
  z.fill(26, 20, 32, 23, T.BRUSH);
  z.fill(34, 25, 38, 28, T.BRUSH);
  z.fill(1, 52, 3, 60, T.BRUSH);
  z.fill(8, 54, 12, 56, T.BRUSH);
  z.fill(14, 36, 16, 38, T.RUBBLE);
  z.fill(23, 36, 25, 37, T.RUBBLE);
  z.fill(2, 36, 3, 38, T.RUBBLE);

  // North of the overpass: the "deep" area with better loot and the lift.
  z.fill(10, 3, 16, 9, T.WALL);                    // collapsed warehouse
  z.fill(11, 4, 15, 8, T.FLOOR);
  z.set(13, 9, T.FLOOR); z.set(10, 6, T.RUBBLE);
  z.addContainer('crate', 11, 4, ['cherry']);
  z.addContainer('crate', 15, 4, ['mango', 'grapefruit']);
  z.fill(26, 3, 36, 9, T.BRUSH);                   // overgrown yard guarding the 12-pack
  z.fill(29, 5, 33, 7, T.GROUND);
  z.addContainer('crate', 31, 6, ['pack']);
  z.addContainer('cooler', 24, 10, ['cherry', 'mango']);
  z.fill(2, 3, 8, 10, T.GRASS);
  z.addLift(5, 6);                                 // the one lift for phase 1
  z.fill(3, 11, 7, 12, T.RUBBLE);

  // Outer ring of wall so the player can't walk off the zone.
  z.fill(0, 0, 39, 0, T.WALL); z.fill(0, 63, 39, 63, T.WALL);
  z.fill(0, 0, 0, 63, T.WALL); z.fill(39, 0, 39, 63, T.WALL);

  // Loose cans near the spawn and along the way.
  z.addCan('lime', 16.5, 58.5);
  z.addCan('lime', 23.5, 58.5);
  z.addCan('grapefruit', 21.5, 53.5);
  z.addCan('lime', 14.5, 35.5);
  z.addCan('lime', 25.5, 29.5);
  z.addCan('grapefruit', 9.5, 27.5);
  z.addCan('mango', 36.5, 12.5);

  // Machines (phase 2). Skitters sit at a home spot; drones and the strider
  // loop through waypoints. Nothing starts within sight of the spawn.
  z.addMachine('skitter', 30.5, 53.5);        // parking lot
  z.addMachine('skitter', 35.5, 58.5);        // parking lot, far corner
  z.addMachine('skitter', 25.5, 44.5);        // gas station forecourt
  z.addMachine('skitter', 8.5, 44.5);         // inside the store
  z.addMachine('skitter', 10.5, 31.5);        // cross street, west
  z.addMachine('skitter', 19.5, 15.5);        // under the overpass
  z.addMachine('skitter', 13.5, 6.5);         // warehouse interior
  z.addMachine('skitter', 36.5, 11.5);        // north-east, by the mango can
  z.addMachine('drone', 24, 34, [{ x: 24, y: 34 }, { x: 34, y: 34 }, { x: 34, y: 46 }, { x: 22, y: 46 }]);   // gas station loop
  z.addMachine('drone', 6, 36, [{ x: 6, y: 36 }, { x: 16, y: 36 }, { x: 16, y: 26 }, { x: 6, y: 26 }]);      // store + cross street
  z.addMachine('drone', 12, 11.5, [{ x: 12, y: 11.5 }, { x: 22, y: 11.5 }, { x: 22, y: 3 }, { x: 12, y: 3 }]); // warehouse / north road
  z.addMachine('strider', 30, 12.2, [{ x: 22.5, y: 12.2 }, { x: 37.5, y: 12.2 }, { x: 37.5, y: 2.5 }, { x: 22.5, y: 2.5 }]); // guards the 12-pack

  z.spawn = { x: 19.5, y: 61.5 };
  return z;
}

// ===========================================================================
// Seeded zone generation (phase 3)
// ===========================================================================
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
class Rng {
  constructor(seed) { this.f = mulberry32(seed >>> 0); }
  next() { return this.f(); }
  int(a, b) { return a + Math.floor(this.f() * (b - a + 1)); }
  chance(p) { return this.f() < p; }
  pick(arr) { return arr[Math.floor(this.f() * arr.length)]; }
  shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(this.f() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
}

// Grid BFS from (sx,sy). Returns Int32Array of step distances, -1 = unreachable.
// `clearance` requires the 8 neighbours to be free too (for the strider).
// `blocked(x,y)` optionally forbids extra tiles.
function gridDistances(z, sx, sy, clearance, blocked) {
  const w = z.w, n = w * z.h;
  const dist = new Int32Array(n).fill(-1);
  const q = new Int32Array(n);
  const ok = (x, y) => {
    if (!z.inb(x, y) || z.isSolid(x, y)) return false;
    if (blocked && blocked(x, y)) return false;
    if (!clearance) return true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (z.isSolid(x + dx, y + dy)) return false;
    return true;
  };
  if (!ok(sx, sy)) return dist;
  let qh = 0, qt = 0; q[qt++] = sy * w + sx; dist[sy * w + sx] = 0;
  while (qh < qt) {
    const i = q[qh++], x = i % w, y = (i / w) | 0, d = dist[i];
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0), ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
      if (!ok(nx, ny)) continue;
      const j = ny * w + nx;
      if (dist[j] !== -1) continue;
      dist[j] = d + 1; q[qt++] = j;
    }
  }
  return dist;
}

// Tile-grid line of sight (same rules the machines use).
function zoneLOS(z, x0, y0, x1, y1) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  if (d < 0.01) return true;
  const ang = Math.atan2(y1 - y0, x1 - x0), dx = Math.cos(ang), dy = Math.sin(ang);
  let tx = Math.floor(x0), ty = Math.floor(y0);
  const tx1 = Math.floor(x1), ty1 = Math.floor(y1);
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity, tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = dx !== 0 ? (dx > 0 ? tx + 1 - x0 : x0 - tx) * tDeltaX : Infinity;
  let tMaxY = dy !== 0 ? (dy > 0 ? ty + 1 - y0 : y0 - ty) * tDeltaY : Infinity;
  for (let i = 0; i < 200; i++) {
    let t;
    if (tMaxX < tMaxY) { t = tMaxX; tMaxX += tDeltaX; tx += stepX; } else { t = tMaxY; tMaxY += tDeltaY; ty += stepY; }
    if (t >= d) return true;
    if (tx === tx1 && ty === ty1) return true;
    if (z.isOpaque(tx, ty)) return false;
  }
  return true;
}

const LOOT_COUNT = { vending: [2, 3], cooler: [2, 3], crate: [1, 2], car: [0, 2] };
// Tier weights by depth band: [lime, grapefruit, mango, cherry]
const LOOT_WEIGHTS = [
  { max: 0.28, w: [78, 20, 2, 0] },
  { max: 0.5,  w: [50, 34, 14, 2] },
  { max: 0.72, w: [28, 34, 28, 10] },
  { max: 9,    w: [14, 26, 36, 24] },
];
function rollCan(rng, depth) {
  const band = LOOT_WEIGHTS.find(b => depth < b.max);
  const total = band.w.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < 4; i++) { r -= band.w[i]; if (r < 0) return ['lime', 'grapefruit', 'mango', 'cherry'][i]; }
  return 'lime';
}

function buildZone(rng, zoneNum, seed) {
  const W = 40, H = 64;
  const z = new Zone(W, H);
  z.name = 'Zone #' + zoneNum; z.num = zoneNum; z.seed = seed;
  const res = new Uint8Array(W * H);          // reserved for layout (roads, buildings, lifts...)
  const reserve = (x0, y0, x1, y1) => { for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) res[y * W + x] = 1; };
  const isFree = (x0, y0, x1, y1, m) => {
    m = m || 0;
    if (x0 - m < 1 || y0 - m < 1 || x1 + m > W - 2 || y1 + m > H - 2) return false;
    for (let y = y0 - m; y <= y1 + m; y++) for (let x = x0 - m; x <= x1 + m; x++) if (res[y * W + x]) return false;
    return true;
  };
  const rects = { buildings: [], lot: null, gas: null };
  const doors = [];

  // --- 1. ground and overgrowth ---
  const g1 = rng.int(0, 1e6), g2 = rng.int(0, 1e6), grassAmount = 0.3 + rng.next() * 0.25;
  z.fill(0, 0, W - 1, H - 1, T.GROUND);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (hash2((x >> 2) + g1, (y >> 2) + g2) < grassAmount && hash2(x + g2, y + g1) < 0.85) z.set(x, y, T.GRASS);
  }

  // --- 2. roads ---
  const rx = rng.int(14, 22);                      // main N–S road, 4 wide
  z.fill(rx, 0, rx + 3, H - 1, T.ROAD); reserve(rx - 1, 0, rx + 4, H - 1);
  const cy = rng.int(26, 42);                      // cross street
  z.fill(0, cy, W - 1, cy + 3, T.ROAD); reserve(0, cy - 1, W - 1, cy + 4);
  for (let y = 1; y < H - 1; y += 2) if (y < cy - 1 || y > cy + 4) z.decor.push({ k: 'dash', x: rx + 1.9, y: y + 0.2, w: 0.2, h: 1.1 });
  for (let x = 1; x < W - 1; x += 2) if (x < rx - 1 || x > rx + 4) z.decor.push({ k: 'dash', x: x + 0.2, y: cy + 1.9, w: 1.1, h: 0.2 });

  // --- 3. highway overpass ---
  const oy = rng.int(9, Math.min(16, cy - 10));
  z.fill(0, oy - 1, W - 1, oy + 4, T.RUBBLE);
  z.fill(0, oy, W - 1, oy + 3, T.WALL);
  z.fill(rx - 1, oy, rx + 4, oy + 3, T.ROAD);      // underpass
  reserve(0, oy - 2, W - 1, oy + 5);
  const gaps = rng.int(1, 2);
  const gapXs = [];
  for (let i = 0; i < gaps; i++) {
    const west = i === 0 ? rng.chance(0.5) : !(gapXs[0] < rx);
    const gx = west ? rng.int(2, rx - 5) : rng.int(rx + 7, W - 5);
    gapXs.push(gx);
    z.fill(gx, oy, gx + 1, oy + 3, T.RUBBLE);
  }

  // --- 4. spawn at the bottom of the main road ---
  z.spawn = { x: rx + 2, y: H - 2.5 };
  reserve(rx - 4, H - 8, rx + 7, H - 1);

  // --- 6. gas station: shop + forecourt beside the main road ---
  for (let tries = 0; tries < 200 && !rects.gas; tries++) {
    const east = rng.chance(0.5);
    const fw = rng.int(11, 13), fh = 5, sw = rng.int(8, 10), sh = rng.int(5, 6);
    const fy = rng.int(oy + 8, H - 14);
    const fx = east ? rx + 6 : rx - 2 - fw;
    const sx = east ? fx + Math.floor((fw - sw) / 2) : fx + Math.floor((fw - sw) / 2);
    const sy = rng.chance(0.5) ? fy - sh - 1 : fy + fh + 1;   // shop north or south of the forecourt
    if (!isFree(Math.min(fx, sx), Math.min(fy, sy), Math.max(fx + fw, sx + sw) - 1, Math.max(fy + fh, sy + sh) - 1, 1)) continue;
    z.fill(fx, fy, fx + fw - 1, fy + fh - 1, T.LOT);
    reserve(fx - 1, fy - 1, fx + fw, fy + fh);
    z.set(fx, fy, T.WALL); z.set(fx + fw - 1, fy, T.WALL); z.set(fx, fy + fh - 1, T.WALL); z.set(fx + fw - 1, fy + fh - 1, T.WALL); // canopy pillars
    const py = fy + 2;
    z.set(fx + 3, py, T.WALL); z.set(fx + fw - 4, py, T.WALL);                                                       // pumps
    const b = { x: sx, y: sy, w: sw, h: sh, doors: [], gas: true };
    z.fill(sx, sy, sx + sw - 1, sy + sh - 1, T.WALL); z.fill(sx + 1, sy + 1, sx + sw - 2, sy + sh - 2, T.FLOOR);
    reserve(sx - 1, sy - 1, sx + sw, sy + sh);
    const doorY = sy < fy ? sy + sh - 1 : sy;   // door faces the forecourt
    const dx0 = sx + Math.floor(sw / 2) - 1;
    for (let k = 0; k < 2; k++) { z.set(dx0 + k, doorY, T.FLOOR); doors.push({ x: dx0 + k, y: doorY }); b.doors.push({ x: dx0 + k, y: doorY }); }
    // vending machines against the shop's front wall, outside
    const outY = sy < fy ? sy + sh : sy - 1;
    z.addContainer('vending', sx + 1, outY, []); z.addContainer('vending', sx + sw - 2, outY, []);
    rects.gas = { fx, fy, fw, fh, shop: b };
    rects.buildings.push(b);
  }

  // --- 7. parking lot of wrecks ---
  for (let tries = 0; tries < 200 && !rects.lot; tries++) {
    const lw = rng.int(13, 16), lh = rng.int(9, 12);
    const alongMain = rng.chance(0.6);
    let lx, ly;
    if (alongMain) { lx = rng.chance(0.5) ? rx + 6 : rx - 2 - lw; ly = rng.int(oy + 7, H - lh - 2); }
    else { lx = rng.int(2, W - lw - 3); ly = rng.chance(0.5) ? cy - 2 - lh : cy + 6; }
    if (!isFree(lx, ly, lx + lw - 1, ly + lh - 1, 1)) continue;
    z.fill(lx, ly, lx + lw - 1, ly + lh - 1, T.LOT);
    reserve(lx - 1, ly - 1, lx + lw, ly + lh);
    for (let ry = ly + 2; ry + 1 <= ly + lh - 2; ry += 4) {
      for (let cx = lx + 1; cx + 1 <= lx + lw - 2; cx += 3) {
        z.decor.push({ k: 'line', x: cx + 2.9, y: ry - 1, w: 0.12, h: 3 });
        if (rng.chance(0.55)) z.addContainer('car', cx, ry, []);
      }
    }
    rects.lot = { x: lx, y: ly, w: lw, h: lh };
  }

  // --- 9. lifts: one far north, one or two elsewhere, all well away from spawn ---
  const liftCount = rng.int(2, 3);
  const tryLift = (minY, maxY, minSpawnDist) => {
    for (let tries = 0; tries < 300; tries++) {
      const lx = rng.int(3, W - 4), ly = rng.int(Math.max(3, minY), Math.min(H - 4, maxY));
      if (!isFree(lx - 1, ly - 1, lx + 1, ly + 1, 1)) continue;
      if (Math.hypot(lx + 0.5 - z.spawn.x, ly + 0.5 - z.spawn.y) < minSpawnDist) continue;
      if (z.lifts.some(l => Math.hypot(l.x - lx, l.y - ly) < 16)) continue;
      z.addLift(lx, ly); reserve(lx - 2, ly - 2, lx + 2, ly + 2);
      return true;
    }
    return false;
  };
  tryLift(2, oy - 3, 36);
  tryLift(oy + 6, H - 14, 20);
  if (liftCount === 3) tryLift(2, H - 12, 24);

  // --- 5. collapsed buildings ---
  const placeBuilding = (x, y, w, h) => {
    z.fill(x, y, x + w - 1, y + h - 1, T.WALL);
    z.fill(x + 1, y + 1, x + w - 2, y + h - 2, T.FLOOR);
    reserve(x - 1, y - 1, x + w, y + h);
    const b = { x, y, w, h, doors: [] };
    // 1–2 doors on different sides, each 1–2 wide
    const sides = rng.shuffle(['n', 's', 'e', 'w']);
    const nd = rng.int(1, 2);
    for (let i = 0; i < nd; i++) {
      const s = sides[i];
      const wide = rng.chance(0.5) ? 2 : 1;
      let dx, dy;
      if (s === 'n' || s === 's') { dx = rng.int(x + 2, x + w - 2 - wide); dy = s === 'n' ? y : y + h - 1; for (let k = 0; k < wide; k++) { z.set(dx + k, dy, T.FLOOR); doors.push({ x: dx + k, y: dy }); b.doors.push({ x: dx + k, y: dy }); } }
      else { dy = rng.int(y + 2, y + h - 2 - wide); dx = s === 'w' ? x : x + w - 1; for (let k = 0; k < wide; k++) { z.set(dx, dy + k, T.FLOOR); doors.push({ x: dx, y: dy + k }); b.doors.push({ x: dx, y: dy + k }); } }
    }
    // collapsed wall sections
    const nc = rng.int(0, 2);
    for (let i = 0; i < nc; i++) {
      const s = sides[(nd + i) % 4], len = rng.int(2, 3);
      if (s === 'n' || s === 's') { const cx0 = rng.int(x + 1, x + w - 1 - len); z.fill(cx0, s === 'n' ? y : y + h - 1, cx0 + len - 1, s === 'n' ? y : y + h - 1, T.RUBBLE); }
      else { const cy0 = rng.int(y + 1, y + h - 1 - len); z.fill(s === 'w' ? x : x + w - 1, cy0, s === 'w' ? x : x + w - 1, cy0 + len - 1, T.RUBBLE); }
    }
    // interior debris
    const nr = rng.int(1, 4);
    for (let i = 0; i < nr; i++) z.set(rng.int(x + 2, x + w - 3), rng.int(y + 2, y + h - 3), T.RUBBLE);
    rects.buildings.push(b);
    return b;
  };
  const nb = rng.int(3, 5);
  let northBuilding = false;
  for (let i = 0, tries = 0; i < nb && tries < 400; tries++) {
    const w = rng.int(7, 12), h = rng.int(6, 10);
    const x = rng.int(1, W - w - 2), y = rng.int(1, H - h - 2);
    if (!isFree(x, y, x + w - 1, y + h - 1, 1)) continue;
    placeBuilding(x, y, w, h); i++;
    if (y + h <= oy - 1) northBuilding = true;
  }
  if (!northBuilding) {
    for (let tries = 0; tries < 200; tries++) {
      const w = rng.int(7, 11), h = rng.int(5, 7);
      const x = rng.int(1, W - w - 2), y = rng.int(1, oy - h - 2);
      if (y < 1 || !isFree(x, y, x + w - 1, y + h - 1, 1)) continue;
      placeBuilding(x, y, w, h); break;
    }
  }

  // --- 8. brush and rubble ---
  const blobs = rng.int(9, 14);
  for (let i = 0; i < blobs; i++) {
    const bx = rng.int(2, W - 3), by = rng.int(2, H - 3), r = 1.2 + rng.next() * 2.2;
    for (let y = Math.floor(by - r); y <= by + r; y++) for (let x = Math.floor(bx - r); x <= bx + r; x++) {
      if (!z.inb(x, y) || res[y * W + x]) continue;
      if ((x - bx) ** 2 + (y - by) ** 2 <= r * r * (0.7 + hash2(x + g1, y) * 0.6)) z.set(x, y, T.BRUSH);
    }
  }
  const rub = rng.int(6, 10);
  for (let i = 0; i < rub; i++) {
    const bx = rng.int(2, W - 3), by = rng.int(2, H - 3), r = 0.8 + rng.next() * 1.4;
    for (let y = Math.floor(by - r); y <= by + r; y++) for (let x = Math.floor(bx - r); x <= bx + r; x++) {
      if (!z.inb(x, y) || res[y * W + x]) continue;
      if ((x - bx) ** 2 + (y - by) ** 2 <= r * r) z.set(x, y, T.RUBBLE);
    }
  }

  // --- 10. wrecks on the roads ---
  const roadCars = rng.int(3, 5);
  for (let i = 0, tries = 0; i < roadCars && tries < 100; tries++) {
    const onMain = rng.chance(0.65);
    let x, y, rot;
    if (onMain) { x = rng.chance(0.5) ? rx : rx + 2; y = rng.int(2, H - 10); rot = true; }
    else { x = rng.int(2, W - 4); y = rng.chance(0.5) ? cy : cy + 2; rot = false; }
    const w = rot ? 1 : 2, h = rot ? 2 : 1;
    let ok = true;
    for (let yy = y - 1; yy <= y + h && ok; yy++) for (let xx = x - 1; xx <= x + w && xx <= W - 1; xx++) {
      const t = z.get(xx, yy);
      if (!(t === T.ROAD) || z.isSolid(xx, yy)) { ok = false; break; }
    }
    if (!ok) continue;
    if (Math.abs(y - oy - 1.5) < 5 || (onMain && Math.abs(y - cy - 1.5) < 5)) continue;   // keep the underpass and crossing clear
    z.addContainer('car', x, y, [], { rot }); i++;
  }

  // --- 11. containers inside buildings ---
  const containerFits = (x, y) => {
    if (!z.inb(x, y) || z.isSolid(x, y) || z.get(x, y) !== T.FLOOR) return false;
    if (doors.some(d => Math.abs(d.x - x) <= 1 && Math.abs(d.y - y) <= 1)) return false;
    for (const c of z.containers) if (x >= c.x - 1 && x <= c.x + c.w && y >= c.y - 1 && y <= c.y + c.h) return false;
    return true;
  };
  for (const b of rects.buildings) {
    const perim = [];
    for (let x = b.x + 1; x <= b.x + b.w - 2; x++) { perim.push([x, b.y + 1]); perim.push([x, b.y + b.h - 2]); }
    for (let y = b.y + 2; y <= b.y + b.h - 3; y++) { perim.push([b.x + 1, y]); perim.push([b.x + b.w - 2, y]); }
    rng.shuffle(perim);
    const wants = b.gas ? ['cooler', 'vending'] : [];
    if (!b.gas) { const nv = rng.int(0, 2), ncool = rng.int(0, 1), ncr = rng.int(1, 3); for (let i = 0; i < nv; i++) wants.push('vending'); for (let i = 0; i < ncool; i++) wants.push('cooler'); for (let i = 0; i < ncr; i++) wants.push('crate'); }
    let pi = 0;
    for (const type of wants) {
      while (pi < perim.length && !containerFits(perim[pi][0], perim[pi][1])) pi++;
      if (pi >= perim.length) break;
      z.addContainer(type, perim[pi][0], perim[pi][1], []); pi++;
    }
  }
  // a few crates out in the open, mostly north
  const openCrates = rng.int(3, 5);
  for (let i = 0, tries = 0; i < openCrates && tries < 200; tries++) {
    const x = rng.int(2, W - 3), y = rng.chance(0.6) ? rng.int(2, oy - 3) : rng.int(oy + 6, H - 10);
    const t = z.get(x, y);
    if (res[y * W + x] || z.isSolid(x, y) || (t !== T.GROUND && t !== T.GRASS && t !== T.RUBBLE)) continue;
    if (z.containers.some(c => Math.abs(c.x - x) <= 1 && Math.abs(c.y - y) <= 1)) continue;
    z.addContainer('crate', x, y, []); i++;
  }

  // --- 12. depth from spawn, then loot by depth ---
  const dist = gridDistances(z, Math.floor(z.spawn.x), Math.floor(z.spawn.y), false);
  let maxD = 1; for (let i = 0; i < dist.length; i++) if (dist[i] > maxD) maxD = dist[i];
  const depthAt = (x, y) => { const d = dist[Math.floor(y) * W + Math.floor(x)]; return d < 0 ? 1 : d / maxD; };
  const containerDepth = c => {
    let best = -1;
    for (let y = c.y - 1; y <= c.y + c.h; y++) for (let x = c.x - 1; x <= c.x + c.w; x++) { if (!z.inb(x, y)) continue; const d = dist[y * W + x]; if (d >= 0 && (best < 0 || d < best)) best = d; }
    return best < 0 ? 1 : best / maxD;
  };
  for (const c of z.containers) {
    c.depth = containerDepth(c);
    const [lo, hi] = LOOT_COUNT[c.type];
    let n = rng.int(lo, hi);
    if (c.type === 'car' && rng.chance(0.35)) n = 0;
    c.loot = []; for (let i = 0; i < n; i++) c.loot.push(rollCan(rng, c.depth));
  }
  // the one legendary 12-pack: deepest crate or cooler, preferably north of the overpass
  const legCands = z.containers.filter(c => (c.type === 'crate' || c.type === 'cooler') && c.y < oy);
  const pool = legCands.length ? legCands : z.containers.filter(c => c.type === 'crate' || c.type === 'cooler');
  let leg = null; for (const c of pool) if (!leg || c.depth > leg.depth) leg = c;
  if (leg) { leg.loot = ['pack']; leg.legendary = true; }

  // --- 13. loose cans ---
  const nLoose = rng.int(9, 14);
  for (let i = 0, tries = 0; i < nLoose && tries < 300; tries++) {
    const x = rng.int(1, W - 2), y = rng.int(1, H - 2);
    if (z.isSolid(x, y) || dist[y * W + x] < 0) continue;
    if (Math.hypot(x - z.spawn.x, y - z.spawn.y) < 3) continue;
    const type = i < 3 && depthAt(x, y) < 0.35 ? 'lime' : rollCan(rng, depthAt(x, y));
    z.addCan(type, x + 0.5, y + 0.5); i++;
  }

  // --- 14. machines ---
  const spawnDist = (x, y) => Math.hypot(x - z.spawn.x, y - z.spawn.y);
  const nearLift = (x, y, r) => z.lifts.some(l => Math.hypot(l.x - x, l.y - y) < r);
  const nSk = rng.int(8, 10);
  for (let i = 0, tries = 0; i < nSk && tries < 500; tries++) {
    let x, y;
    if (rng.chance(0.65) && z.containers.length) {   // guard loot
      const c = rng.pick(z.containers);
      x = c.x + rng.int(-3, 3); y = c.y + rng.int(-3, 3);
    } else { x = rng.int(2, W - 3); y = rng.int(2, H - 3); }
    if (x < 2 || y < 2 || x > W - 3 || y > H - 3 || z.isSolid(x, y) || dist[y * W + x] < 0) continue;
    if (z.get(x, y) === T.BRUSH) continue;
    if (depthAt(x, y) < 0.22 || spawnDist(x + 0.5, y + 0.5) < 14) continue;
    if (nearLift(x, y, 3) || z.machines.some(m => Math.hypot(m.x - x, m.y - y) < 4)) continue;
    z.addMachine('skitter', x + 0.5, y + 0.5); i++;
  }
  // drones loop around loot-dense structures
  const anchors = rng.shuffle(rects.buildings.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h })));
  if (rects.lot) anchors.push(rects.lot);
  const nDr = Math.min(rng.int(2, 3), anchors.length);
  for (let i = 0; i < nDr; i++) {
    const a = anchors[i];
    const c = (x, y) => ({ x: Math.max(2, Math.min(W - 3, x)), y: Math.max(2, Math.min(H - 3, y)) });
    const wps = [c(a.x - 2, a.y - 2), c(a.x + a.w + 1, a.y - 2), c(a.x + a.w + 1, a.y + a.h + 1), c(a.x - 2, a.y + a.h + 1)];
    if (rng.chance(0.5)) wps.reverse();
    const start = wps[rng.int(0, 3)];
    z.addMachine('drone', start.x, start.y, wps);
  }
  // the strider walks a loop around the legendary can
  if (leg) {
    const lx = leg.x + 0.5, ly = leg.y + 0.5, hr = rng.int(5, 7);
    const snap = (x, y) => {   // nearest tile with clearance for the big walker
      let best = null;
      for (let r = 0; r <= 5 && !best; r++) for (let dy = -r; dy <= r && !best; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = Math.round(x) + dx, ty = Math.round(y) + dy;
        if (tx < 2 || ty < 2 || tx > W - 3 || ty > H - 3) continue;
        let ok = true;
        for (let yy = -1; yy <= 1 && ok; yy++) for (let xx = -1; xx <= 1; xx++) if (z.isSolid(tx + xx, ty + yy)) { ok = false; break; }
        if (ok && !nearLift(tx, ty, 4)) { best = { x: tx + 0.5, y: ty + 0.5 }; break; }
      }
      return best;
    };
    const corners = [snap(lx - hr, ly - hr), snap(lx + hr, ly - hr), snap(lx + hr, ly + hr), snap(lx - hr, ly + hr)].filter(Boolean);
    if (corners.length >= 3) z.addMachine('strider', corners[0].x, corners[0].y, corners);
  }

  // --- 15. border ---
  z.fill(0, 0, W - 1, 0, T.WALL); z.fill(0, H - 1, W - 1, H - 1, T.WALL);
  z.fill(0, 0, 0, H - 1, T.WALL); z.fill(W - 1, 0, W - 1, H - 1, T.WALL);
  z.overpassY = oy; z.hasGas = !!rects.gas; z.hasLot = !!rects.lot;
  return z;
}

// Every check the spec asks for. Returns { ok, reason }.
function validateZone(z) {
  const W = z.w;
  const sx = Math.floor(z.spawn.x), sy = Math.floor(z.spawn.y);
  if (z.isSolid(sx, sy)) return { ok: false, reason: 'spawn blocked' };
  if (z.lifts.length < 2) return { ok: false, reason: 'fewer than 2 lifts' };
  if (!z.hasGas) return { ok: false, reason: 'no gas station' };
  if (!z.hasLot) return { ok: false, reason: 'no parking lot' };
  const dist = gridDistances(z, sx, sy, false);
  for (const l of z.lifts) if (dist[Math.floor(l.y) * W + Math.floor(l.x)] < 0) return { ok: false, reason: 'lift unreachable' };
  for (const c of z.containers) {
    let ok = false;
    for (let y = c.y - 1; y <= c.y + c.h && !ok; y++) for (let x = c.x - 1; x <= c.x + c.w; x++) if (z.inb(x, y) && dist[y * W + x] >= 0) { ok = true; break; }
    if (!ok) return { ok: false, reason: 'container unreachable ' + c.type };
  }
  for (const c of z.cans) if (dist[Math.floor(c.y) * W + Math.floor(c.x)] < 0) return { ok: false, reason: 'can unreachable' };
  if (!z.containers.some(c => c.legendary)) return { ok: false, reason: 'no legendary' };
  if (!z.machines.some(m => m.kind === 'strider')) return { ok: false, reason: 'no strider' };
  if (z.machines.filter(m => m.kind === 'skitter').length < 6) return { ok: false, reason: 'too few skitters' };
  if (z.machines.filter(m => m.kind === 'drone').length < 2) return { ok: false, reason: 'too few drones' };
  // no machine starts within sight of the spawn
  for (const m of z.machines) {
    const d = Math.hypot(m.x - z.spawn.x, m.y - z.spawn.y);
    if (d < 14 && zoneLOS(z, z.spawn.x, z.spawn.y, m.x, m.y)) return { ok: false, reason: 'machine in sight of spawn' };
    if (m.kind !== 'drone' && z.isSolid(Math.floor(m.x), Math.floor(m.y))) return { ok: false, reason: 'machine in wall' };
  }
  // the strider can actually walk its loop
  const st = z.machines.find(m => m.kind === 'strider');
  for (let i = 0; i < st.waypoints.length; i++) {
    const a = st.waypoints[i], b = st.waypoints[(i + 1) % st.waypoints.length];
    const d = gridDistances(z, Math.floor(a.x), Math.floor(a.y), true);
    if (d[Math.floor(b.y) * W + Math.floor(b.x)] < 0) return { ok: false, reason: 'strider loop blocked' };
  }
  // a reasonably safe route: spawn to some lift avoiding machine patrol zones (brush is always safe)
  const segDist = (px, py, a, b) => {
    const vx = b.x - a.x, vy = b.y - a.y, L = vx * vx + vy * vy;
    const t = L ? Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / L)) : 0;
    return Math.hypot(px - (a.x + vx * t), py - (a.y + vy * t));
  };
  const danger = (x, y) => {
    if (z.get(x, y) === T.BRUSH) return false;
    const cx = x + 0.5, cyy = y + 0.5;
    for (const m of z.machines) {
      if (m.kind === 'skitter') { if (Math.hypot(m.x - cx, m.y - cyy) < 3.5) return true; }
      else {
        const r = m.kind === 'drone' ? 5 : 8;
        const w = m.waypoints;
        for (let i = 0; i < w.length; i++) if (segDist(cx, cyy, w[i], w[(i + 1) % w.length]) < r) return true;
      }
    }
    return false;
  };
  const safe = gridDistances(z, sx, sy, false, danger);
  if (!z.lifts.some(l => safe[Math.floor(l.y) * W + Math.floor(l.x)] >= 0)) return { ok: false, reason: 'no safe route to a lift' };
  return { ok: true };
}

function generateZone(zoneNum) {
  let lastReason = '';
  for (let attempt = 0; attempt < 80; attempt++) {
    const seed = (Math.imul(zoneNum, 2654435761) + Math.imul(attempt + 1, 40503) + 7919) >>> 0;
    const z = buildZone(new Rng(seed), zoneNum, seed);
    const v = validateZone(z);
    if (v.ok) { z.attempt = attempt; return z; }
    lastReason = v.reason;
  }
  const z = makeTestZone();
  z.name = 'Zone #' + zoneNum + ' (fallback)'; z.num = zoneNum; z.attempt = -1; z.lastReason = lastReason;
  return z;
}
