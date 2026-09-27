// Local player controller: input → actor intent + camera yaw/pitch + aim point.
//
// Look: mouse is raw 1:1 (pointer lock, unadjusted movement — no smoothing, no acceleration). Aim assist: friction slows the
// look near an enemy under the crosshair, tracking assist carries a fraction of the target's angular motion while
// you are actively aiming or moving — never an auto-snap. Bullet magnetism pulls shots onto the body line of an enemy
// the crosshair is actually touching (at the height you aimed), so hits register exactly as they look.
//
// Touch (phones) adds three helpers so the game plays without fine thumb work, each a setting that defaults on:
//   · lock-on      — while fire / bomb is held, the view swings onto the best enemy in a wide cone in front of you
//   · camera follow — with the look thumb idle, the view turns toward where the move stick is steering (one-thumb play)
//   · auto pitch   — with no vertical drag for a moment, the view settles to a height that inks the floor ahead
import * as THREE from 'three';
import { G, clamp, lerp, angleDiff, damp, dampAngle } from '../core/ctx.js';
import { PLAYER } from '../config.js';
import { Physics, Hit } from './physics.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _fwd = new THREE.Vector3(), _c = new THREE.Vector3();
const _hit = new Hit();
const _res = { t: 0, dist: 0 };
const DEG = Math.PI / 180;

export class PlayerController {
  constructor(actor, rig, input) {
    this.a = actor; this.rig = rig; this.input = input;
    this.mapHeld = false;
    this.onTarget = null;
    this.inRange = false;
    this.enabled = true;
    this.assist = { target: null, yaw: 0, pitch: 0, has: false, strength: 0 };
    this.lock = null;             // touch lock-on target (actor) — the HUD draws a ring on it
    this._lockYaw = 0; this._lockPitch = 0;
    this._lookIdle = 9;           // s since the last look drag (touch)
    this._vLookIdle = 9;          // s since the last drag with a real vertical component
  }

  update(dt) {
    const a = this.a, rig = this.rig, inp = this.input, s = G.settings;
    const it = a.intent;
    if (!this.enabled) {
      it.move.set(0, 0, 0); it.fire = it.jump = it.squid = it.sub = it.special = false;
      this.assist.has = false; this.lock = null;
      return;
    }
    // ---- aim assist target (computed from last frame's camera; cheap)
    const tc = inp.touch;
    const touch = !!tc?.active;
    const assistOn = touch ? s.aimAssistTouch !== false : s.aimAssistMouse;
    const as = this._assistTarget(assistOn ? 0.5 : 0);
    // ---- look
    const friction = as ? lerp(1, 0.58, as.closeness * as.strength) : 1;
    let lookActive = false;
    // while the map diorama is up the mouse steers the map cursor
    const mapUp = (G.rig?.mapK ?? 0) > 0.05 || inp.down('Tab') || inp.down('KeyM') || !!tc?.map;
    const mdx = mapUp ? 0 : inp.mouse.dx, mdy = mapUp ? 0 : inp.mouse.dy;
    if (mdx || mdy) {
      const sens = 0.0021 * (s.sensitivity ?? 1) * (s.aimAssistMouse ? friction : 1);
      rig.yaw -= mdx * sens;
      rig.pitch -= mdy * sens;
      lookActive = true;
    }
    // touch look: CSS px of finger drag (a thumb swipe across half a phone screen ≈ a half turn)
    const tdx = mapUp || !tc ? 0 : tc.lookDx, tdy = mapUp || !tc ? 0 : tc.lookDy;
    if (tdx || tdy) {
      const sens = 0.0068 * (s.touchSensitivity ?? 1) * (assistOn ? friction : 1);
      rig.yaw -= tdx * sens;
      rig.pitch -= tdy * sens * 0.8;
      lookActive = true;
      this._lookIdle = 0;
      if (Math.abs(tdy) > 1.5) this._vLookIdle = 0;
    }
    this._lookIdle += dt; this._vLookIdle += dt;
    // ---- move (camera relative)
    let mx = 0, mz = 0;
    if (inp.down('KeyW') || inp.down('ArrowUp')) mz += 1;
    if (inp.down('KeyS') || inp.down('ArrowDown')) mz -= 1;
    if (inp.down('KeyA') || inp.down('ArrowLeft')) mx -= 1;
    if (inp.down('KeyD') || inp.down('ArrowRight')) mx += 1;
    if (tc && (tc.moveX || tc.moveY)) { mx += tc.moveX; mz += tc.moveY; }
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    // tracking assist: carry a share of the target's angular motion while the player is engaging (look or move input)
    if (as && as.prevValid && (lookActive || ml > 0.2 || it.fire)) {
      const share = 0.42 * as.strength * as.closeness;
      rig.yaw += angleDiff(as.prevYaw, as.yaw) * share;
      rig.pitch += (as.pitch - as.prevPitch) * share * 0.7;
    }
    if (touch && !mapUp) this._touchHelpers(dt, mx, mz, ml, tc, lookActive);
    else this.lock = null;
    rig.pitch = clamp(rig.pitch, -1.05, 1.15);
    a.aimYaw = rig.yaw;
    a.aimPitch = rig.pitch;
    const sy = Math.sin(rig.yaw), cy = Math.cos(rig.yaw);
    // forward = (sy, 0, cy); right = (-cy, 0, sy)
    it.move.set(sy * mz - cy * mx, 0, cy * mz + sy * mx);

    it.jump = inp.down('Space') || !!tc?.jump;
    it.squid = inp.down('ShiftLeft') || inp.down('ShiftRight') || !!tc?.squid;
    it.fire = inp.mouse.left || !!tc?.fire;
    it.sub = inp.mouse.right || inp.down('KeyE') || !!tc?.sub;
    it.special = inp.down('KeyF') || inp.down('KeyQ') || !!tc?.special;
    this.mapHeld = inp.down('Tab') || inp.down('KeyM') || !!tc?.map;
    // the TAB map is a targeting UI (clicking a teammate beacon super jumps) — never fire or throw through it
    if (this.mapHeld) { it.fire = false; it.sub = false; }
    // super jump: while the map is open, 1-3 jumps to a teammate, 4 to spawn
    if (this.mapHeld && a.canSuperJump()) {
      const allies = G.actors.filter((o) => o.team === a.team && o !== a);
      const pick = (i) => { const o = allies[i]; if (o && o.alive && !o.superJumpState) a.superJump(o); };
      if (inp.wasPressed('Digit1')) pick(0);
      if (inp.wasPressed('Digit2')) pick(1);
      if (inp.wasPressed('Digit3')) pick(2);
      if (inp.wasPressed('Digit4')) { const p = G.level.spawnPads[a.team]; a.superJump(p.clone()); }
    }

    // ---- aim point from the camera centre ray
    this.computeAim();
  }

  // ---- touch helpers (see the header). Fire / sub input is read straight off the touch state: the intent is set after.
  _touchHelpers(dt, mx, mz, ml, tc, lookActive) {
    const a = this.a, rig = this.rig, s = G.settings;
    const engaging = !!(tc.fire || tc.sub || a.weaponRunner?.charging);
    // lock-on: pick (or keep) a target; while engaging, swing onto it. A drag still wins — it only slows the pull, and
    // dragging past the cone drops the lock.
    this.lock = s.autoAimTouch !== false && a.alive ? this._lockTarget() : null;
    if (this.lock && engaging) {
      const k = lookActive ? 3 : 13;
      rig.yaw = dampAngle(rig.yaw, this._lockYaw, k, dt);
      rig.pitch = damp(rig.pitch, this._lockPitch, k * 0.85, dt);
    }
    if (s.cameraFollowTouch === false || a.superJumpState) return;
    // camera follow: strafing turns the view toward the heading (pure strafes most, straight ahead / back not at all)
    if (this._lookIdle > 0.45 && ml > 0.25 && !(this.lock && engaging)) {
      const rel = Math.atan2(mx, mz);
      if (Math.abs(rel) < 2.4) rig.yaw -= Math.sin(rel) * ml * (tc.fire ? 0.8 : 1.3) * dt;
    }
    // auto pitch: rest at the height that puts the crosshair on the floor at ~80 % of the weapon's range
    if (this._vLookIdle > 1.2 && !this.lock && !a.climbing && a.anim?.form !== 'climb') {
      const w = a.weapon;
      const rest = w.kind === 'charger' ? -0.07 : clamp(-Math.atan2(2.1, (rig.curDist || 5) + this._range(w) * 0.8), -0.3, -0.06);
      rig.pitch = damp(rig.pitch, rest, 1.6, dt);
    }
  }

  _range(w) { return w.kind === 'charger' ? w.rangeMax : w.kind === 'roller' ? 6 : (w.range || 12); }

  // Lock-on target: enemies in range, in a wide yaw cone around the view, in line of sight. The current lock is kept
  // over a wider cone so it doesn't flick between two kids standing side by side.
  _lockTarget() {
    const a = this.a, rig = this.rig, cam = G.rig?.gameCam || G.camera;
    if (!cam) return null;
    const range = this._range(a.weapon) * 1.1 + 1;
    let best = null, bestScore = Infinity;
    _v2.copy(a.pos); _v2.y += 1.3;
    for (const e of G.actors) {
      if (e.team === a.team || !e.alive || e.anim.form === 'swim' || e.invuln > 0) continue;
      const d = Math.hypot(e.pos.x - a.pos.x, e.pos.z - a.pos.z);
      if (d > range) continue;
      _c.set(e.pos.x, e.pos.y + (e.smoothY || 0) + (e.form === 'squid' ? 0.3 : 0.95), e.pos.z);
      const dyaw = Math.abs(angleDiff(rig.yaw, Math.atan2(_c.x - cam.position.x, _c.z - cam.position.z)));
      const cone = (e === this.lock ? 40 : 28) * DEG;
      if (dyaw > cone || Math.abs(_c.y - a.pos.y) > 7) continue;
      if (!G.physics.los(_v2, _c)) continue;
      const score = dyaw / cone + (d / range) * 0.6 - (e === this.lock ? 0.3 : 0);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    if (best) {
      _c.set(best.pos.x, best.pos.y + (best.smoothY || 0) + (best.form === 'squid' ? 0.3 : 0.95), best.pos.z);
      _v.copy(_c).sub(cam.position);
      this._lockYaw = Math.atan2(_v.x, _v.z);
      this._lockPitch = clamp(Math.asin(clamp(_v.y / Math.max(1e-3, _v.length()), -1, 1)), -1.0, 1.1);
    }
    return best;
  }

  // Best enemy near the crosshair for aim assist (angular cone scaled so it covers ~a body width at any range).
  _assistTarget(strength) {
    const as = this.assist;
    const a = this.a, cam = G.camera;
    if (!(strength > 0) || !cam) { as.has = false; as.target = null; return null; }
    const fwd = cam.getWorldDirection(_fwd);
    const w = a.weapon;
    const maxR = Math.min(32, (w.kind === 'charger' ? w.rangeMax : w.kind === 'roller' ? 7 : (w.range || 12)) * 1.15 + 2);
    let best = null, bestScore = Infinity, bYaw = 0, bPitch = 0, bClose = 0;
    for (const e of G.actors) {
      if (e.team === a.team || !e.alive || e.anim.form === 'swim' || e.invuln > 0) continue;
      _c.set(e.pos.x, e.pos.y + (e.smoothY || 0) + (e.form === 'squid' ? 0.3 : 0.95), e.pos.z);
      _v.copy(_c).sub(cam.position);
      const d = _v.length();
      if (d > maxR + 4 || d < 0.5) continue;
      if (a.pos.distanceTo(e.pos) > maxR) continue;
      _v.multiplyScalar(1 / d);
      const ang = Math.acos(clamp(_v.dot(fwd), -1, 1));
      const cone = clamp(Math.atan2(1.0, d), 2.5 * DEG, 10 * DEG);
      if (ang > cone) continue;
      if (!G.physics.los(cam.position, _c)) continue;
      const score = ang / cone + d * 0.01;
      if (score < bestScore) { bestScore = score; best = e; bYaw = Math.atan2(_v.x, _v.z); bPitch = Math.asin(clamp(_v.y, -1, 1)); bClose = 1 - ang / cone; }
    }
    if (!best) { as.has = false; as.target = null; return null; }
    as.prevValid = as.has && as.target === best;
    as.prevYaw = as.yaw; as.prevPitch = as.pitch;
    as.target = best; as.yaw = bYaw; as.pitch = bPitch; as.closeness = clamp(bClose * 1.3, 0, 1); as.strength = strength; as.has = true;
    return as;
  }

  computeAim() {
    // the gameplay view — while the map diorama is up the rendered camera is overhead, aim stays with the player
    const a = this.a, cam = G.rig?.gameCam || G.camera;
    const fwd = cam.getWorldDirection(_fwd);
    // start the ray level with the player so geometry between camera and player is ignored
    _v.copy(a.pos); _v.y += 1.3;
    const along = Math.max(0, _v.sub(cam.position).dot(fwd));
    const start = _v2.copy(cam.position).addScaledVector(fwd, along);
    const hit = G.physics.raycast(start, fwd, 70, _hit, true);
    const dist = hit.hit ? hit.dist : 70;
    a.aimPoint.copy(start).addScaledVector(fwd, dist);
    // enemy under the crosshair? (visual body, generous by 0.2 m)
    this.onTarget = null;
    let best = dist, bestT = 0;
    const reach = Math.min(dist, 34);
    const end = _v.copy(start).addScaledVector(fwd, reach);
    for (const e of G.actors) {
      if (e.team === a.team || !e.alive) continue;
      if (e.anim.form === 'swim') continue;
      _c.set(e.pos.x, e.pos.y + (e.smoothY || 0), e.pos.z);
      Physics.segmentCapsuleDist(start, end, _c, PLAYER.radius, e.form === 'squid' ? PLAYER.squidHeight : PLAYER.height, _res);
      if (_res.dist < PLAYER.radius + 0.2) {
        const d = _res.t * reach;
        if (d < best) { best = d; bestT = _res.t; this.onTarget = e; }
      }
    }
    if (this.onTarget) {
      // bullet magnetism: converge on the enemy's body axis at the height the crosshair crosses it
      const e = this.onTarget;
      const h = e.form === 'squid' ? PLAYER.squidHeight : PLAYER.height;
      const py = start.y + fwd.y * best;
      const baseY = e.pos.y + (e.smoothY || 0);
      a.aimPoint.set(e.pos.x, clamp(py, baseY + 0.2, baseY + h - 0.12), e.pos.z);
    }
    // is the crosshair point inside the weapon's effective range? (HUD reticle state)
    const range = this._range(a.weapon);
    this.inRange = a.aimPoint.distanceTo(a.pos) <= range + 0.5;
  }
}
