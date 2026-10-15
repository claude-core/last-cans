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

  z.spawn = { x: 19.5, y: 61.5 };
  return z;
}
