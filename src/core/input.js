// Keyboard and mouse (pointer lock) input for each frame. Touch controls (ui/touch.js) write into Input.touch.

// keys whose browser default (focus moves, page scroll) must never fire while the game has the mouse
const GAME_KEYS = new Set(['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'Quote']);

// phones / tablets: a coarse primary pointer (or ?touch to try the touch controls on a desktop)
export const isTouchDevice = () => {
  try {
    if (new URLSearchParams(location.search).has('touch')) return true;
    return matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches);
  } catch { return false; }
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();       // keys pressed this frame
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false };
    this.locked = false;
    this.enabled = true;
    // move stick (-1..1, y = forward), look drag in CSS px this frame, held buttons
    this.touch = { active: isTouchDevice(), moveX: 0, moveY: 0, lookDx: 0, lookDy: 0, fire: false, squid: false, jump: false, sub: false, special: false, map: false };
    this.onKey = null;              // (e) => bool consumed  (menus)
    window.addEventListener('keydown', (e) => {
      // the menus call preventDefault themselves when needed (text fields must still receive keystrokes)
      // auto-repeat must be swallowed too: holding TAB for the map used to let the repeats move browser focus off the
      // canvas → pointer lock dropped → the round paused ("opening the map opens the menu")
      if (e.repeat) {
        if (e.code === 'Tab' || (this.locked && GAME_KEYS.has(e.code))) e.preventDefault();
        if (this.onKey) this.onKey(e, true);
        return;
      }
      if (this.onKey && this.onKey(e, false)) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (GAME_KEYS.has(e.code) && this.locked) e.preventDefault();
      if (e.code === 'Tab') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX; this.mouse.dy += e.movementY;
    });
    window.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.mouse.left = this.mouse.right = false; this.onUnlock?.(); }
    });
  }

  requestLock() {
    if (this.locked) return;
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      // some platforms reject unadjustedMovement: fall back to a plain request
      if (p && p.catch) p.catch(() => { try { const q = this.canvas.requestPointerLock(); if (q && q.catch) q.catch(() => {}); } catch { /* ignore */ } });
    } catch { /* not allowed without a gesture */ }
  }
  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  down(code) { return this.keys.has(code); }
  wasPressed(code) { return this.pressed.has(code); }

  // Call once at the very end of each frame.
  endFrame() {
    this.pressed.clear();
    this.mouse.dx = 0; this.mouse.dy = 0;
    this.mouse.leftPressed = false; this.mouse.rightPressed = false;
    this.touch.lookDx = 0; this.touch.lookDy = 0;
  }
}
