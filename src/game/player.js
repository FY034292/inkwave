// Local player controller: input → actor intent + camera yaw/pitch + aim point.
//
// Look: mouse is raw 1:1 (pointer lock, unadjusted movement — no smoothing, no acceleration). Aim assist: friction slows the
// look near an enemy under the crosshair, tracking assist carries a fraction of the target's angular motion while
// you are actively aiming or moving — never an auto-snap. Bullet magnetism pulls shots onto the body line of an enemy
// the crosshair is actually touching (at the height you aimed), so hits register exactly as they look.
import * as THREE from 'three';
import { G, clamp, lerp, angleDiff } from '../core/ctx.js';
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
  }

  update(dt) {
    const a = this.a, rig = this.rig, inp = this.input, s = G.settings;
    const it = a.intent;
    if (!this.enabled) {
      it.move.set(0, 0, 0); it.fire = it.jump = it.squid = it.sub = it.special = false;
      this.assist.has = false;
      return;
    }
    // ---- aim assist target (computed from last frame's camera; cheap)
    const as = this._assistTarget(s.aimAssistMouse ? 0.5 : 0);
    // ---- look
    const friction = as ? lerp(1, 0.58, as.closeness * as.strength) : 1;
    let lookActive = false;
    // while the map diorama is up the mouse steers the map cursor
    const mapUp = (G.rig?.mapK ?? 0) > 0.05 || inp.down('Tab') || inp.down('KeyM');
    const mdx = mapUp ? 0 : inp.mouse.dx, mdy = mapUp ? 0 : inp.mouse.dy;
    if (mdx || mdy) {
      const sens = 0.0021 * (s.sensitivity ?? 1) * (s.aimAssistMouse ? friction : 1);
      rig.yaw -= mdx * sens;
      rig.pitch -= mdy * sens;
      lookActive = true;
    }
    // ---- move (camera relative)
    let mx = 0, mz = 0;
    if (inp.down('KeyW') || inp.down('ArrowUp')) mz += 1;
    if (inp.down('KeyS') || inp.down('ArrowDown')) mz -= 1;
    if (inp.down('KeyA') || inp.down('ArrowLeft')) mx -= 1;
    if (inp.down('KeyD') || inp.down('ArrowRight')) mx += 1;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    // tracking assist: carry a share of the target's angular motion while the player is engaging (look or move input)
    if (as && as.prevValid && (lookActive || ml > 0.2 || it.fire)) {
      const share = 0.42 * as.strength * as.closeness;
      rig.yaw += angleDiff(as.prevYaw, as.yaw) * share;
      rig.pitch += (as.pitch - as.prevPitch) * share * 0.7;
    }
    rig.pitch = clamp(rig.pitch, -1.05, 1.15);
    a.aimYaw = rig.yaw;
    a.aimPitch = rig.pitch;
    const sy = Math.sin(rig.yaw), cy = Math.cos(rig.yaw);
    // forward = (sy, 0, cy); right = (-cy, 0, sy)
    it.move.set(sy * mz - cy * mx, 0, cy * mz + sy * mx);

    it.jump = inp.down('Space');
    it.squid = inp.down('ShiftLeft') || inp.down('ShiftRight');
    it.fire = inp.mouse.left;
    it.sub = inp.mouse.right || inp.down('KeyE');
    it.special = inp.down('KeyF') || inp.down('KeyQ');
    this.mapHeld = inp.down('Tab') || inp.down('KeyM');
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
    const w = a.weapon;
    const range = w.kind === 'charger' ? w.rangeMax : w.kind === 'roller' ? 6 : (w.range || 12);
    this.inRange = a.aimPoint.distanceTo(a.pos) <= range + 0.5;
  }
}
