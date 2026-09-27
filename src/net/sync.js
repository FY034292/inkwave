// Friend match: keeps one match in step across the players of a room.
//
// Authority is split the way Splatoon splits it:
//  · every player simulates their own squidkid (movement, weapons, ink, specials); the host also runs the CPU players
//    and owns the match clock and the final judge
//  · each machine sends its actors' state NET.sendRate times a second, plus what they did: rounds fired (re-flown on
//    the other machines as visual-only "ghosts"), every splat they painted, animation one-shots, splats/respawns
//  · a hit lands on the attacker's machine (what you see is what you hit) and is sent to the victim's owner, which
//    applies the damage and reports the splat back
// Remote players are drawn NET.interpDelay behind their owner's clock; their events replay on that same timeline, so
// a shot leaves the gun when the gun is seen there and its paint lands when the ghost round does.
//
// Wire frame (relayed as '#'+JSON): { f: sender member id, ts: sender ms clock, s: [actor states], e: [events], p: [splats] }
import * as THREE from 'three';
import { G, on, emit, clamp, angleDiff } from '../core/ctx.js';
import { NET, PLAYER, WEAPONS } from '../config.js';
import { BotBrain } from '../game/bots.js';

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const v3 = (v) => [r2(v.x), r2(v.y), r2(v.z)];
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

// actor state flags
const F_ALIVE = 1, F_GROUND = 2, F_FIRE = 4, F_ROLL = 8, F_SUBAIM = 16, F_INVULN = 32, F_ENEMY = 64, F_CHARGE = 128,
  F_SPECIAL = 256, F_SUBMERGED = 512, F_CLIMB = 1024;
const FORMS = ['kid', 'squid', 'swim', 'climb'];
// projectile fields copied onto a ghost round (everything a fire* call sets that the flight / look depends on)
const SHOT_KEYS = ['type', 'wid', 'life', 'straight', 'radius', 'damage', 'dmgFar', 'size', 'trail', 'trailEvery', 'trailRadius', 'grav', 'drag',
  'seed', 'vis', 'tail0', 'tailK', 'wob', 'wobF', 'nose', 'sats', 'delay', 'head'];
// bus events of an owned actor replayed on the other machines (vectors travel as [x, y, z])
const RELAYED = ['actor:jump', 'actor:land', 'special:use', 'special:slam', 'superjump', 'superjump:land', 'weapon:dodge'];
const VEC_KEYS = ['pos', 'to', 'dir'];
// what a remote weapon sounds like when it fires near you (the owner's fire* calls play these for themselves)
const FIRE_SND = {
  shooter: ['shoot_shooter', 0.4], dualies: ['shoot_dualies', 0.36], splatling: ['shoot_splatling', 0.33],
  blaster: ['shoot_blaster', 0.5], charger: ['shoot_charger', 0.6],
};
const TRIGGER_SND = { flick: ['roller_flick', 0.6], slosh: ['slosh_throw', 0.55] };

function packArg(arg) {
  if (arg == null) return 0;
  if (typeof arg === 'number') return r3(arg);
  if (typeof arg === 'object') {
    const o = {};
    for (const k of ['x', 'z', 'amp', 't', 'hand']) if (typeof arg[k] === 'number') o[k] = r3(arg[k]);
    return o;
  }
  return 0;
}
function unpackArg(a) {
  if (a && typeof a === 'object') return { ...a, valueOf() { return this.amp ?? 1; } };
  return a;
}

export class NetSync {
  /** game: the Game (main.js) · client: NetClient · start: the host's start payload { roster, … } */
  constructor(game, client, start) {
    this.game = game;
    this.client = client;
    this.start = start;
    this.myId = client.myId;
    this.hostId = start.host;
    this.match = null;
    this.byId = new Map();          // netId → actor
    this.mute = 0;                  // > 0: paint calls are dropped (a remote player's ghost is being simulated)
    this.recordOff = 0;             // > 0: paint is local-only (cosmetic droplets)
    this.events = [];
    this.splats = [];
    this.pending = [];              // received frames waiting for their replay time
    this.clock = new Map();         // sender id → estimated (local ms − sender ms)
    this.ready = new Set();
    this.readyAt = 0;
    this.started = false;
    this.pendingState = null;       // host match state received before this machine finished loading
    this.sendAcc = 0;
    this.syncT = 0;
    this._vols = new WeakMap(); this._volN = 0;
    this._unsubs = [client.on('relay', (s) => this._onRelay(s)), client.on('left', (o) => this._onLeft(o))];
  }

  get isHost() { return this.myId === this.hostId; }
  owned(a) { return !!a && a.netOwner === this.myId; }
  now() { return performance.now(); }

  // ------------------------------------------------------------------------------------------ lifecycle
  attach(match) {
    this.match = match;
    G.net = this;
    for (const a of match.actors) {
      this.byId.set(a.netId, a);
      a._nb = [];
      this._wrapTrigger(a);
      if (a.remote) a.smoothY = 0;
    }
    // paint: record what this machine paints, drop what a ghost would paint
    const paint = G.paint;
    const orig = (this._origSplat = paint.splat);
    this._paint = paint;
    paint.splat = (c, r, team, opts = {}) => {
      if (this.mute > 0) return 0;
      const area = orig.call(paint, c, r, team, opts);
      if (this.recordOff === 0 && !opts.cosmetic && this.started) this._recordSplat(c, r, team, opts);
      return area;
    };
    const L = (name, fn) => this._unsubs.push(on(name, fn));
    L('weapon:fire', (e) => {
      if (!this.owned(e.actor)) return;
      this.events.push(['w', e.actor.netId, e.weapon, v3(e.muzzle), [r3(e.dir.x), r3(e.dir.y), r3(e.dir.z)], r3(e.charge || 0), r2(e.len || 0), e.hand | 0]);
    });
    L('splatted', (e) => {
      if (!this.owned(e.victim)) return;
      this.events.push(['k', e.victim.netId, e.attacker ? e.attacker.netId : -1, String(e.cause || '')]);
    });
    L('respawn', (e) => { if (this.owned(e.actor)) this.events.push(['r', e.actor.netId]); });
    for (const name of RELAYED) {
      L(name, (e) => {
        if (!e || !this.owned(e.actor)) return;
        const o = {};
        for (const k in e) {
          if (k === 'actor') continue;
          const v = e[k];
          if (v && v.isVector3) o[k] = v3(v);
          else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') o[k] = typeof v === 'number' ? r3(v) : v;
        }
        this.events.push(['v', name, e.actor.netId, o]);
      });
    }
    L('match:state', ({ state, match: m }) => {
      if (m !== this.match || !this.isHost) return;
      if (state === 'judge' && m.result) this._control(['jd', r3(m.result.coverage[0]), r3(m.result.coverage[1]), m.result.winner]);
      else this._control(['ms', state, r2(m.time)]);
    });
  }

  detach() {
    for (const u of this._unsubs) u();
    this._unsubs = [];
    if (this._paint && this._origSplat) this._paint.splat = this._origSplat;
    this._paint = null;
    if (G.net === this) G.net = null;
    this.match = null;
  }

  /** This machine has built the stage and the actors: tell the host (the host counts itself). */
  markReady() {
    this.readyAt = this.now();
    if (this.isHost) { this.ready.add(this.myId); this._checkReady(); }
    else this._control(['rdy']);
    if (this.pendingState) { const s = this.pendingState; this.pendingState = null; this._applyControl(this.hostId, s); }
  }

  _humans() {
    const ids = new Set(this.start.roster.filter((r) => !r.bot).map((r) => r.owner));
    const present = new Set((this.client.room?.members || []).map((m) => m.id));
    return [...ids].filter((id) => present.has(id));
  }

  _checkReady() {
    if (!this.isHost || this.started || !this.match) return;
    const all = this._humans().every((id) => this.ready.has(id));
    const late = this.readyAt && this.now() - this.readyAt > NET.readyTimeout * 1000;
    if (all || late) this._go();
  }

  _go() {
    if (this.started) return;
    this.started = true;
    if (this.isHost) this.match.start();      // emits match:state intro → broadcast
    this.game._netGo?.();
  }

  // ------------------------------------------------------------------------------------------ outbound
  _control(ev) {
    // match control goes out at once, outside the frame cadence
    this.client.relay(JSON.stringify({ f: this.myId, ts: Math.round(this.now()), c: [ev] }));
  }

  onShot(p) {
    if (!this.started || !this.owned(p.owner)) return;
    const f = {};
    for (const k of SHOT_KEYS) {
      const v = p[k];
      if (v === undefined || v === null || v === false) continue;
      f[k] = typeof v === 'number' ? r3(v) : v;
    }
    // slosher waves share one volley record (a ring the owner reuses): number each wave from its head glob
    let vol = 0;
    if (p.vol) { if (p.head || !this._vols.has(p.vol)) this._vols.set(p.vol, ++this._volN); vol = this._vols.get(p.vol); }
    this.events.push(['s', p.owner.netId, f, v3(p.pos), [r3(p.vel.x), r3(p.vel.y), r3(p.vel.z)], vol]);
  }

  onThrow(a, kind, pos, vel) {
    if (!this.started || !this.owned(a)) return;
    this.events.push(['b', a.netId, kind, v3(pos), [r3(vel.x), r3(vel.y), r3(vel.z)]]);
  }

  sendHit(attacker, victim, dmg, wid) {
    if (!this.owned(attacker)) return;
    // storm rain arrives every frame: fold it into one hit per victim per frame sent
    const last = this.events[this.events.length - 1];
    if (last && last[0] === 'h' && last[1] === attacker.netId && last[2] === victim.netId && last[4] === wid) { last[3] = r2(last[3] + dmg); return; }
    this.events.push(['h', attacker.netId, victim.netId, r2(dmg), String(wid || '')]);
  }

  _recordSplat(c, r, team, o) {
    const s = [r2(c.x), r2(c.y), r2(c.z), r3(r), team, r3(o.seed ?? Math.random())];
    if (o.kind || o.stretch) {
      s.push(o.kind || 0);
      if (o.stretch) s.push(r3(o.stretch.x), r3(o.stretch.y), r3(o.stretch.z), r3(o.stretchAmt ?? 0));
    }
    this.splats.push(s);
  }

  _snapshot(a) {
    const an = a.anim, wr = a.weaponRunner;
    let fl = 0;
    if (a.alive) fl |= F_ALIVE;
    if (a.grounded) fl |= F_GROUND;
    if (wr.firingPose()) fl |= F_FIRE;
    if (wr.rolling) fl |= F_ROLL;
    if (wr.aimingSub) fl |= F_SUBAIM;
    if (a.invuln > 0) fl |= F_INVULN;
    if (a.onEnemy) fl |= F_ENEMY;
    if (wr.charging) fl |= F_CHARGE;
    if (a.specialActive) fl |= F_SPECIAL;
    if (a.submerged) fl |= F_SUBMERGED;
    if (a.climbing) fl |= F_CLIMB;
    const form = Math.max(0, FORMS.indexOf(an.form));
    const st = a.stats;
    return [a.netId, r2(a.pos.x), r2(a.pos.y + (a.smoothY || 0)), r2(a.pos.z), r2(a.vel.x), r2(a.vel.y), r2(a.vel.z),
      r3(a.yaw), r3(a.aimYaw), r3(a.aimPitch), fl, r3(wr.charge || 0), Math.round(a.ink), Math.round(a.hp), Math.round(a.special),
      form, an.surface | 0, r2(an.wallNormal.x), r2(an.wallNormal.z), Math.round(st.turf), st.splats, st.deaths, r2(Math.max(0, a.respawnTimer))];
  }

  /** once per frame, after the simulation: send a frame when it's due */
  postUpdate(dt) {
    if (!this.match) return;
    this.sendAcc += dt;
    const period = 1 / NET.sendRate;
    if (this.sendAcc < period) return;
    this.sendAcc = Math.min(this.sendAcc - period, period);
    const m = this.match;
    const s = [];
    if (this.started) for (const a of m.actors) if (this.owned(a)) s.push(this._snapshot(a));
    // the host re-states the clock every second (a player who stalled catches up)
    if (this.isHost && this.started && m.state === 'playing' && (this.syncT += period) > 1) { this.syncT = 0; this.events.push(['ms', 'playing', r2(m.time)]); }
    if (!s.length && !this.events.length && !this.splats.length) return;
    const frame = { f: this.myId, ts: Math.round(this.now()), s };
    if (this.events.length) frame.e = this.events;
    if (this.splats.length) frame.p = this.splats;
    this.client.relay(JSON.stringify(frame));
    this.events = [];
    this.splats = [];
  }

  // ------------------------------------------------------------------------------------------ inbound
  _onRelay(str) {
    let o;
    try { o = JSON.parse(str); } catch { return; }
    if (!o || o.f === this.myId) return;
    const now = this.now();
    // sender clock → ours: the smallest offset seen is the least-delayed frame; drift upward slowly to follow it
    const off = now - o.ts, c = this.clock.get(o.f);
    this.clock.set(o.f, c === undefined || off < c ? off : c + (off - c) * 0.004);
    if (o.c) for (const ev of o.c) this._applyControl(o.f, ev);
    if (!this.match) return;
    if (o.s) {
      for (const snap of o.s) {
        const a = this.byId.get(snap[0]);
        if (!a || !a.remote || a.netOwner !== o.f) continue;
        const buf = a._nb;
        if (buf.length && buf[buf.length - 1].t >= o.ts) continue;   // out of order
        buf.push({ t: o.ts, s: snap });
        if (buf.length > 40) buf.splice(0, buf.length - 40);
      }
    }
    if (o.e || o.p) this.pending.push(o);
  }

  _applyControl(from, ev) {
    const m = this.match;
    switch (ev[0]) {
      case 'rdy':
        if (this.isHost) { this.ready.add(from); this._checkReady(); }
        break;
      case 'ms': {
        if (from !== this.hostId) break;
        if (!m || !this.readyAt) { this.pendingState = ev; break; }
        const [, state, t] = ev;
        if (!this.started && (state === 'intro' || state === 'playing')) this._go();
        if (state === 'intro' && m.state === 'init') m.start();
        else if (state === 'playing') {
          if (m.state === 'init' || m.state === 'intro') m.setState('playing');
          if (m.state === 'playing' && Math.abs(m.time - t) > 0.25) m.time = t;
        } else if (state === 'finish' && (m.state === 'playing' || m.state === 'intro')) { m.time = 0; m.setState('finish'); }
        break;
      }
      case 'jd':
        if (from !== this.hostId || !m) break;
        m.result = { coverage: [ev[1], ev[2]], winner: ev[3] };
        if (m.state !== 'judge' && m.state !== 'results') { m.time = 0; m.setState('judge'); }
        break;
    }
  }

  /** once per frame before the simulation: replay due events, then pose the remote players */
  preUpdate(dt) {
    if (!this.match) return;
    const now = this.now(), delay = NET.interpDelay * 1000;
    if (this.pending.length) {
      let keep = 0;
      for (let i = 0; i < this.pending.length; i++) {
        const fr = this.pending[i];
        const due = fr.ts + (this.clock.get(fr.f) ?? 0) + delay <= now;
        if (due) this._applyFrame(fr);
        else this.pending[keep++] = fr;
      }
      this.pending.length = keep;
    }
    if (this.isHost && !this.started) this._checkReady();
    for (const a of this.match.actors) if (a.remote) this._pose(a, dt, now - (this.clock.get(a.netOwner) ?? 0) - delay);
  }

  _applyFrame(fr) {
    if (fr.p) {
      const paint = this._paint, orig = this._origSplat;
      for (const s of fr.p) {
        _v.set(s[0], s[1], s[2]);
        const opts = { seed: s[5] };
        if (s.length > 6 && s[6]) opts.kind = s[6];
        if (s.length > 7) { opts.stretch = _v2.set(s[7], s[8], s[9]); opts.stretchAmt = s[10]; }
        orig.call(paint, _v, s[3], s[4], opts);
      }
    }
    if (fr.e) for (const ev of fr.e) { try { this._applyEvent(fr.f, ev); } catch (e) { console.warn('[net] event', ev[0], e); } }
  }

  _applyEvent(from, ev) {
    const P = G.projectiles;
    switch (ev[0]) {
      case 's': {                                         // a round fired → ghost
        const a = this.byId.get(ev[1]);
        if (!a || !a.remote) return;
        P.spawnGhost(a, { f: ev[2], p: ev[3], v: ev[4], vol: ev[5] });
        return;
      }
      case 'w': {                                         // weapon fired: sound, muzzle flash, charger beam
        const a = this.byId.get(ev[1]);
        if (!a || !a.remote || !a.alive) return;
        const [, , wid, m, d, charge, len, hand] = ev;
        const muzzle = new THREE.Vector3(m[0], m[1], m[2]), dir = new THREE.Vector3(d[0], d[1], d[2]);
        const kind = (WEAPONS[wid] || a.weapon).kind;
        if (kind === 'charger') P.ghostBeam(a, muzzle, dir, len, charge);
        if (a._nearCamera()) {
          const snd = FIRE_SND[kind];
          if (snd) G.audio?.play(snd[0], { pos: muzzle, volume: snd[1], pitch: kind === 'charger' ? 1.08 - 0.16 * charge : 1 });
          if (kind === 'shooter' || kind === 'dualies' || kind === 'splatling') G.fx?.muzzle(muzzle, dir, a.color, 'shooter');
          if (kind === 'slosher') G.fx?.muzzle(muzzle, dir, a.color, 'blaster');
        }
        emit('weapon:fire', { actor: a, weapon: wid, muzzle, dir, charge, len, hand });
        return;
      }
      case 'b': {                                         // bomb / storm thrown
        const a = this.byId.get(ev[1]);
        if (!a || !a.remote) return;
        const ghost = { pos: new THREE.Vector3(...ev[3]), vel: new THREE.Vector3(...ev[4]) };
        if (ev[2] === 'storm') P.throwStorm(a, ghost); else P.throwBomb(a, ghost);
        return;
      }
      case 't': {                                         // animation one-shot
        const a = this.byId.get(ev[1]);
        if (!a || !a.remote) return;
        a.character.trigger(ev[2], unpackArg(ev[3]));
        const snd = TRIGGER_SND[ev[2]];
        if (snd && a._nearCamera()) G.audio?.play(snd[0], { pos: a.pos, volume: snd[1] });
        return;
      }
      case 'h': {                                         // someone hit an actor this machine owns
        const attacker = this.byId.get(ev[1]), victim = this.byId.get(ev[2]);
        if (!attacker || !victim || !this.owned(victim) || !victim.alive || victim.team === attacker.team) return;
        const killed = victim.damage(ev[3], attacker, ev[4] || 'weapon');
        emit('hit', { attacker, victim, damage: ev[3], killed, weaponId: ev[4] });
        return;
      }
      case 'k': {                                         // a remote actor was splatted
        const victim = this.byId.get(ev[1]), attacker = ev[2] >= 0 ? this.byId.get(ev[2]) : null;
        if (!victim || !victim.remote) return;
        this.mute++;
        try { victim.splat(attacker, ev[3] || 'weapon'); } finally { this.mute--; }
        victim._nb.length = 0;
        if (attacker && this.owned(attacker)) emit('hit', { attacker, victim, damage: 0, killed: true, weaponId: ev[3] });
        return;
      }
      case 'r': {                                         // a remote actor respawned
        const a = this.byId.get(ev[1]);
        if (!a || !a.remote) return;
        this._remoteRespawn(a);
        return;
      }
      case 'v': {                                         // a relayed bus event (fx / audio listeners)
        const a = this.byId.get(ev[2]);
        if (!a || !a.remote) return;
        const e = { ...ev[3], actor: a };
        for (const k of VEC_KEYS) if (Array.isArray(e[k])) e[k] = new THREE.Vector3(e[k][0], e[k][1], e[k][2]);
        this._relayedFx(ev[1], a, e);
        emit(ev[1], e);
        return;
      }
      case 'ms':
        this._applyControl(from, ev);
        return;
    }
  }

  // the parts of an owned-side event that were direct fx / audio calls rather than bus listeners
  _relayedFx(name, a, e) {
    const near = a._nearCamera();
    if (name === 'special:use') G.audio?.play('special_activate', { pos: a.pos, volume: 0.7 });
    else if (name === 'special:slam' && e.pos) {
      G.fx?.explosion(_v.copy(e.pos).setY(e.pos.y + 0.3), a.color, e.radius || 4);
      G.audio?.play('special_slam', { pos: e.pos });
      emit('shake', { pos: e.pos.clone(), amount: 1.0 });
    } else if (name === 'superjump' && e.phase === 'charge') G.audio?.play('super_jump', { pos: a.pos, volume: 0.6 });
    else if (name === 'superjump:land' && e.pos) G.fx?.burst(e.pos, _v2.set(0, 1, 0), a.color, { count: 14, speed: 5, size: 0.09 });
    else if (name === 'actor:jump' && near) G.audio?.play(e.swim ? 'swim_splash' : 'jump', { pos: a.pos, volume: 0.6 });
    else if (name === 'actor:land' && near && (e.speed || 0) > 3) G.audio?.play(e.surface === 1 && a.form === 'squid' ? 'swim_splash' : 'land', { pos: a.pos, volume: clamp((e.speed || 0) / 14, 0.25, 0.9) });
  }

  _remoteRespawn(a) {
    if (a.alive) return;
    a.reset();
    a.invuln = PLAYER.spawnInvuln;
    a._nb.length = 0;
    a.character.setVisible(true);
    a.character.setHurt(0, G.teamColors[a.enemyTeam]);
    const pad = G.level.spawnPads[a.team];
    G.fx?.spawnFlash(_v.set(pad.x, pad.y, pad.z), a.color);
    emit('respawn', { actor: a });
  }

  // ------------------------------------------------------------------------------------------ remote actors
  _pose(a, dt, rt) {
    const buf = a._nb;
    if (!a.alive) {
      a.respawnTimer = Math.max(0, a.respawnTimer - dt);
      // safety net: the respawn event went missing but the owner's state says alive again
      const last = buf[buf.length - 1];
      if (last && (last.s[10] & F_ALIVE) && G.time - (a._deadAt ?? G.time) > PLAYER.respawnTime + 1.5) this._remoteRespawn(a);
      if (!a._deadAt) a._deadAt = G.time;
      return;
    }
    a._deadAt = 0;
    if (!buf.length) return;
    // bracketing states around the render time
    let i = 0;
    while (i < buf.length - 1 && buf[i + 1].t <= rt) i++;
    if (i > 1) { buf.splice(0, i - 1); i = 1; }
    const s0 = buf[i].s, s1 = buf[i + 1] ? buf[i + 1].s : null;
    let k = 0, ext = 0;
    if (s1) k = clamp((rt - buf[i].t) / Math.max(1, buf[i + 1].t - buf[i].t), 0, 1);
    else ext = clamp((rt - buf[i].t) / 1000, 0, 0.15);   // ran dry: carry on along the velocity a moment
    const L = (j) => (s1 ? s0[j] + (s1[j] - s0[j]) * k : s0[j]);
    const S = k < 0.5 || !s1 ? s0 : s1;                  // discrete fields from the nearer state
    const px = L(1) + s0[4] * ext, py = L(2) + (S[10] & F_GROUND ? 0 : s0[5] * ext), pz = L(3) + s0[6] * ext;
    // big gaps (super jump arrival, a stall) snap instead of sliding through walls
    if (s1 && Math.hypot(s1[1] - s0[1], s1[3] - s0[3]) > 6) a.pos.set(S[1], S[2], S[3]); else a.pos.set(px, py, pz);
    a.vel.set(L(4), L(5), L(6));
    const prevYaw = a.yaw;
    a.yaw = s1 ? s0[7] + angleDiff(s0[7], s1[7]) * k : s0[7];
    a.aimYaw = s1 ? s0[8] + angleDiff(s0[8], s1[8]) * k : s0[8];
    a.aimPitch = L(9);
    const fl = S[10];
    a.grounded = !!(fl & F_GROUND);
    a.invuln = fl & F_INVULN ? 1 : 0;
    a.onEnemy = !!(fl & F_ENEMY);
    a.submerged = !!(fl & F_SUBMERGED);
    const climb = !!(fl & F_CLIMB);
    if (climb !== a.climbing) { a.climbing = climb; emit('actor:climb', { actor: a, on: climb }); }
    const formCode = S[15];
    a.form = formCode > 0 ? 'squid' : 'kid';
    a.ink = S[12]; a.hp = S[13]; a.special = S[14];
    a.specialActive = fl & F_SPECIAL ? (a.specialActive || { id: a.weapon.special, t: 0, remote: true }) : null;
    a.groundTeam = S[16];
    // counters from the state at or before the render time: a splat event replayed this frame has already counted
    // itself, and a newer state must not count it a second time
    a.stats.turf = s0[19]; a.stats.splats = s0[20]; a.stats.deaths = s0[21];
    const wr = a.weaponRunner;
    wr.charging = !!(fl & F_CHARGE); wr.charge = S[11]; wr.rolling = !!(fl & F_ROLL); wr.aimingSub = !!(fl & F_SUBAIM);
    wr.firingT = fl & F_FIRE ? 0.2 : 0;
    const cp = Math.cos(a.aimPitch);
    a.aimDir.set(Math.sin(a.aimYaw) * cp, Math.sin(a.aimPitch), Math.cos(a.aimYaw) * cp);
    a.aimPoint.copy(a.pos).addScaledVector(a.aimDir, 25); a.aimPoint.y += 1.1;
    // pose the character (what actor._finishFrame does after the physics)
    const an = a.anim;
    an.time = G.time;
    const hs = Math.hypot(a.vel.x, a.vel.z), cy = Math.cos(a.yaw), sy = Math.sin(a.yaw), inv = 1 / Math.max(hs, 0.001);
    an.speed = hs;
    an.localMove.x = hs > 0.1 ? -(a.vel.x * cy - a.vel.z * sy) * inv : 0;
    an.localMove.z = hs > 0.1 ? (a.vel.x * sy + a.vel.z * cy) * inv : 0;
    an.grounded = a.grounded; an.vy = a.vel.y; an.aimPitch = a.aimPitch;
    an.firing = wr.firingPose(); an.charge = wr.charge; an.rolling = wr.rolling; an.subAim = wr.aimingSub;
    an.form = a.specialActive ? 'kid' : FORMS[formCode] || 'kid';
    an.ink = a.ink / PLAYER.inkMax; an.lowInk = a.ink < 18; an.special = a.specialFrac(); an.invuln = a.invuln > 0;
    an.turnRate = dt > 0 ? clamp(angleDiff(prevYaw, a.yaw) / dt, -20, 20) : 0;
    an.hp = clamp(a.hp / PLAYER.hp, 0, 1); an.inEnemyInk = a.onEnemy; an.surface = a.grounded ? a.groundTeam : 0;
    an.wallNormal.set(S[17], 0, S[18]);
    const ch = a.character;
    ch.root.position.copy(a.pos);
    ch.root.rotation.y = a.yaw;
    ch.setHurt((1 - a.hp / PLAYER.hp) * (a.hp < PLAYER.hp ? 1 : 0), G.teamColors[a.enemyTeam]);
    ch.update(dt, an);
    a._events(an);
    if (an.form === 'swim' && hs > 2 && G.fx) {
      a._wakeT = (a._wakeT || 0) + dt;
      if (a._wakeT > 0.05) { a._wakeT = 0; G.fx.wake(a.pos, _v.set(a.vel.x, 0, a.vel.z).normalize(), a.color, hs); }
    }
  }

  _wrapTrigger(a) {
    const ch = a.character;
    if (ch._netTrigger) return;
    const orig = ch.trigger.bind(ch);
    ch._netTrigger = orig;
    ch.trigger = (name, arg) => {
      orig(name, arg);
      if (this.started && this.owned(a)) this.events.push(['t', a.netId, name, packArg(arg)]);
    };
  }

  // ------------------------------------------------------------------------------------------ people leaving
  _onLeft({ id, host }) {
    if (!this.match) return;
    if (id === this.hostId) {
      // the match clock and the CPUs lived on the host's machine: this round can't finish ('left' names the new host;
      // the room update that makes it official arrives right after)
      this.game._netAbort?.('ホストが退出したため、対戦を終了しました。', host);
      return;
    }
    // a player dropped: the host's CPU takes over their squidkid for the rest of the round
    for (const a of this.match.actors) {
      if (a.netOwner !== id) continue;
      a.netOwner = this.hostId;
      a._nb.length = 0;
      a.isBot = true;
      if (this.isHost) {
        a.remote = false;
        a.smoothY = 0;
        a.weaponRunner.reset();
        a.bot = new BotBrain(a, this.match.opts.difficulty);
        a.bot.aimYaw = a.aimYaw; a.bot.aimPitch = 0;
      }
    }
    this.ready.delete(id);
    this._checkReady();
  }
}
