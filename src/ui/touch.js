// Touch controls for phones / tablets (the PWA build). Writes into Input.touch, which the player controller reads next
// to the keyboard + mouse:
//   · left side   → floating move stick (appears where the thumb lands; analog, with a small dead zone)
//   · right side  → drag anywhere to look; every action button is also a look pad while held, so you can aim while
//                   firing / aiming a bomb / swimming
//   · buttons     → FIRE (hold), SQUID (hold, or tap to latch — tap again, fire or throw to stand up), JUMP, SUB (hold to
//                   aim, release throws), SPECIAL (lights up when charged), MAP (toggle; tap a pin to super jump,
//                   tap anywhere else to close), PAUSE
// Only listens to pointer events of type 'touch' / 'pen', so a mouse on a touch laptop keeps the pointer-lock controls.
import * as THREE from 'three';
import { h, clamp } from './ui-util.js';
import { weaponIcon, SUB_ICONS, specialIcon, SQUID, GLYPHS } from './ui-icons.js';
import { G } from '../core/ctx.js';

const STICK_R = 56;           // px the knob can travel from the stick centre
const DEAD = 0.14;            // stick dead zone (fraction of STICK_R)
const LATCH_TAP = 0.24;       // s — a squid press shorter than this latches squid form
const _p = new THREE.Vector3();
const JUMP_ICON = `<svg class="iw-ico" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 8 L52 30 L40 30 L40 50 L24 50 L24 30 L12 30 Z" fill="currentColor" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/><path d="M16 58 L48 58" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></svg>`;
const PAUSE_ICON = `<svg class="iw-ico" viewBox="0 0 64 64" aria-hidden="true"><rect x="16" y="12" width="11" height="40" rx="4" fill="currentColor"/><rect x="37" y="12" width="11" height="40" rx="4" fill="currentColor"/></svg>`;

export class TouchControls {
  // api: { pause(), mapPinAt(x, y) → pin index | -1, mapJump(i) }
  constructor(input, api) {
    this.input = input; this.api = api;
    this.t = input.touch;
    this.visible = false;
    this.ptrs = new Map();        // pointerId → { role, x, y, x0, y0, t0, btn }
    this.stickId = null;
    this.squidLatch = false;
    this._pend = new Set();
    this.buildDom();
    const el = this.el;
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('pointercancel', (e) => this._up(e));
    el.addEventListener('lostpointercapture', (e) => this._up(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  buildDom() {
    const btn = (id, cls, icon, label) => {
      const b = h('div', { class: 'iw-tc__btn iw-tc__btn--' + cls, 'data-btn': id },
        h('span', { class: 'iw-tc__ico', html: icon }), label ? h('span', { class: 'iw-tc__lbl' }, label) : null);
      return b;
    };
    this.knob = h('div', { class: 'iw-tc__knob' });
    this.stick = h('div', { class: 'iw-tc__stick' }, this.knob);
    this.btns = {
      fire: btn('fire', 'fire', weaponIcon('shooter')),
      squid: btn('squid', 'squid', SQUID, 'イカ'),
      jump: btn('jump', 'jump', JUMP_ICON, 'ジャンプ'),
      sub: btn('sub', 'sub', SUB_ICONS.bomb),
      special: btn('special', 'special', specialIcon('slam')),
      map: btn('map', 'map', GLYPHS.map),
      pause: btn('pause', 'pause', PAUSE_ICON),
    };
    this.stickHint = h('div', { class: 'iw-tc__hint iw-tc__hint--l' }, 'ドラッグで移動');
    this.lookHint = h('div', { class: 'iw-tc__hint iw-tc__hint--r' }, 'ドラッグで視点');
    // lock-on ring: sits on the enemy the auto aim has picked (brighter while it is pulling the view)
    this.lockRing = h('div', { class: 'iw-tc__lock' });
    this.el = h('div', { class: 'iw-tc', 'aria-hidden': 'true' },
      this.lockRing, this.stick, this.stickHint, this.lookHint, Object.values(this.btns));
    document.body.appendChild(this.el);
    this._icons = { weapon: 'shooter', special: 'slam' };
  }

  setVisible(on) {
    if (on === this.visible) return;
    this.visible = on;
    this.el.classList.toggle('is-on', on);
    if (!on) this.releaseAll();
  }

  // drop every held touch (menu opened, round over, app backgrounded)
  releaseAll() {
    this.ptrs.clear();
    this.stickId = null;
    this.squidLatch = false;
    this._pend.clear();
    const t = this.t;
    t.moveX = t.moveY = 0; t.fire = t.squid = t.jump = t.sub = t.special = t.map = false;
    this.stick.classList.remove('is-on');
    for (const b of Object.values(this.btns)) b.classList.remove('is-down');
    this.btns.squid.classList.remove('is-latched');
  }

  // per frame while visible: icons follow the loadout, special lights up when charged, map state mirrors the rig
  update(dt) {
    if (!this.visible) return;
    const a = G.match?.local;
    if (!a) return;
    const col = G.teamHex?.[a.team];
    if (col && col !== this._col) { this._col = col; this.el.style.setProperty('--c', col); }
    const kind = a.weapon?.kind || 'shooter';
    if (kind !== this._icons.weapon) {
      this._icons.weapon = kind;
      this.btns.fire.querySelector('.iw-tc__ico').innerHTML = weaponIcon(kind);
    }
    const sp = a.weapon?.special || 'slam';
    if (sp !== this._icons.special) { this._icons.special = sp; this.btns.special.querySelector('.iw-tc__ico').innerHTML = specialIcon(sp); }
    const ready = !!a.specialReady?.();
    if (ready !== this._ready) { this._ready = ready; this.btns.special.classList.toggle('is-ready', ready); }
    const f = Math.round((a.specialFrac?.() ?? 0) * 100);
    if (f !== this._spf) { this._spf = f; this.btns.special.style.setProperty('--f', f + '%'); }
    // releases land here, after the controller has run: a tap shorter than a frame still registers as a press
    if (this._pend.size) {
      for (const k of this._pend) this.t[k] = k === 'squid' ? this.squidLatch || this._held('squid') : this._held(k);
      this._pend.clear();
    }
    this.el.classList.toggle('is-map', this.t.map);
    this._updLock();
    // hide the how-to hints once the player has moved and looked around
    // (the camera follows the stick, so a player who never drags to look still loses them after a while)
    this._hintT = (this._hintT || 0) + dt;
    if (!this._hintsGone && this._movedT > 0.6 && (this._lookedT > 0.6 || this._hintT > 12)) { this._hintsGone = true; this.el.classList.add('is-seasoned'); }
  }

  _updLock() {
    const L = !this.t.map && G.match?.controller?.lock, cam = G.camera;
    let on = false;
    if (L && cam) {
      _p.set(L.pos.x, L.pos.y + (L.smoothY || 0) + (L.form === 'squid' ? 0.3 : 0.95), L.pos.z).project(cam);
      if (_p.z < 1 && Math.abs(_p.x) < 1.1 && Math.abs(_p.y) < 1.1) {
        on = true;
        const x = (_p.x * 0.5 + 0.5) * innerWidth, y = (-_p.y * 0.5 + 0.5) * innerHeight;
        this.lockRing.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
        const pull = !!(this.t.fire || this.t.sub || G.match?.controller?.autoFiring);
        if (pull !== this._pull) { this._pull = pull; this.lockRing.classList.toggle('is-pull', pull); }
      }
    }
    if (on !== this._lockOn) { this._lockOn = on; this.lockRing.classList.toggle('is-on', on); }
  }

  _roleAt(e) {
    const b = e.target.closest?.('[data-btn]');
    if (b) return { role: 'btn', btn: b.dataset.btn, el: b };
    // the corner minimap opens the big map (it sits in the HUD layer above, which lets touches through)
    const mm = document.querySelector('.iw-map:not(.is-expanded)');
    if (mm && mm.offsetParent) {
      const r = mm.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return { role: 'btn', btn: 'map' };
    }
    return { role: e.clientX < innerWidth * 0.45 ? 'stick' : 'look' };
  }

  _down(e) {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const t = this.t;
    // with the map up, a tap on a pin super jumps and a tap anywhere else closes it (the stick still moves you)
    if (t.map) {
      const r = this._roleAt(e);
      if (r.btn !== 'pause' && (r.role !== 'stick' || r.btn)) {
        const p = { role: 'maptap', x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp };
        this.ptrs.set(e.pointerId, p);
        return;
      }
    }
    const r = this._roleAt(e);
    const p = { role: r.role, btn: r.btn, el: r.el, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp };
    if (r.role === 'stick') {
      if (this.stickId !== null) p.role = 'look';
      else {
        this.stickId = e.pointerId;
        this.stick.style.transform = `translate3d(${e.clientX}px,${e.clientY}px,0)`;
        this.knob.style.transform = 'translate3d(0,0,0)';
        this.stick.classList.add('is-on');
      }
    }
    this.ptrs.set(e.pointerId, p);
    if (p.role !== 'btn') return;
    p.el?.classList.add('is-down');
    switch (p.btn) {
      case 'fire': t.fire = true; this._setLatch(false); break;
      case 'squid': p.wasLatched = this.squidLatch; t.squid = true; this._setLatch(false); break;
      case 'jump': t.jump = true; break;
      case 'sub': t.sub = true; break;
      case 'special': t.special = true; this._setLatch(false); break;
      case 'map': t.map = true; this.releaseMoveButtons(); break;
      case 'pause': break;
    }
  }

  _move(e) {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (e.pointerId === this.stickId) {
      let ox = p.x - p.x0, oy = p.y - p.y0;
      const d = Math.hypot(ox, oy);
      // the stick follows a thumb that runs past its rim (no dead feeling when you over-push)
      if (d > STICK_R) {
        const k = (d - STICK_R) / d;
        p.x0 += ox * k; p.y0 += oy * k; ox = p.x - p.x0; oy = p.y - p.y0;
        this.stick.style.transform = `translate3d(${p.x0}px,${p.y0}px,0)`;
      }
      this.knob.style.transform = `translate3d(${ox}px,${oy}px,0)`;
      const n = Math.min(1, Math.hypot(ox, oy) / STICK_R);
      const m = n < DEAD ? 0 : Math.min(1, (n - DEAD) / (0.86 - DEAD));
      const s = n > 1e-4 ? m / n : 0;
      this.t.moveX = (ox / STICK_R) * s;
      this.t.moveY = (-oy / STICK_R) * s;
      if (m > 0.3) this._movedT = (this._movedT || 0) + 1 / 60;
      return;
    }
    if (p.role === 'maptap' || p.btn === 'map' || p.btn === 'pause') return;
    // every other touch on the right is a look pad
    this.t.lookDx += dx; this.t.lookDy += dy;
    if (Math.abs(dx) + Math.abs(dy) > 1) this._lookedT = (this._lookedT || 0) + 1 / 60;
  }

  _up(e) {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    this.ptrs.delete(e.pointerId);
    const t = this.t;
    if (e.pointerId === this.stickId) {
      this.stickId = null; t.moveX = t.moveY = 0;
      this.stick.classList.remove('is-on');
      return;
    }
    if (p.role === 'maptap') {
      if (e.type !== 'pointerup') return;
      if (Math.hypot(p.x - p.x0, p.y - p.y0) > 24) return;
      const i = this.api.mapPinAt?.(p.x, p.y) ?? -1;
      if (i >= 0) this.api.mapJump?.(i);
      t.map = false;
      return;
    }
    if (p.role !== 'btn') return;
    p.el?.classList.remove('is-down');
    const held = this._held(p.btn);
    if (held) return;
    switch (p.btn) {
      case 'fire': case 'jump': case 'special': this._pend.add(p.btn); break;
      case 'squid': {
        // quick tap latches squid form (thumb is free to jump / look); a tap on a latched squid stands up
        const quick = (e.timeStamp - p.t0) / 1000 < LATCH_TAP && Math.hypot(p.x - p.x0, p.y - p.y0) < 18;
        this._setLatch(quick && !p.wasLatched);
        this._pend.add('squid');
        break;
      }
      case 'sub': this._pend.add('sub'); break;
      case 'map': break;   // stays open until the next tap
      case 'pause': if (e.type === 'pointerup') this.api.pause?.(); break;
    }
  }

  _held(btn) { for (const q of this.ptrs.values()) if (q.role === 'btn' && q.btn === btn) return true; return false; }

  _setLatch(on) {
    if (on === this.squidLatch) return;
    this.squidLatch = on;
    this.btns.squid.classList.toggle('is-latched', on);
    if (!on && !this._held('squid')) this._pend.add('squid');
  }

  // opening the map never leaves fire / sub stuck on
  releaseMoveButtons() {
    const t = this.t;
    t.fire = t.sub = t.special = false;
    for (const [id, p] of this.ptrs) if (p.role === 'btn' && p.btn !== 'map') { p.el?.classList.remove('is-down'); this.ptrs.delete(id); }
  }
}
