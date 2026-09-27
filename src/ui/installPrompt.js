// INKWAVE — "add to home screen" hint for phones opened in a browser tab.
// Starts with the page (index.html loads this module on its own, ahead of the game): in portrait it sits on top of the
// "turn your phone" screen from the first moment; in landscape it shows on the loading / title screens only (their
// top-right corner is free; the main menu has panels there), never in a match.
// A bouncing arrow points at the browser's share / ⋮ button — iPhone Safari keeps share at the bottom in portrait,
// everything else top-right — and on Chrome, where the page receives beforeinstallprompt, a one-tap install button
// replaces the arrow.
// Hidden when already running from the home screen; "×" snoozes it for a week, installing hides it for good.

const KEY = 'inkwave.a2hs';
const SNOOZE_MS = 7 * 24 * 3600 * 1000;
const SCREENS = new Set(['boot', 'loading', 'title']);   // landscape; 'boot' = before the menus exist

const ua = navigator.userAgent || '';
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const portraitMQ = matchMedia('(orientation: portrait)');

function standalone() {
  try { return matchMedia('(display-mode: fullscreen), (display-mode: standalone), (display-mode: minimal-ui)').matches || navigator.standalone === true || /[?&]pwa\b/.test(location.search); }
  catch { return false; }
}
function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ } }

const SHARE_ICON = '<svg class="iw-a2hs__ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const MENU_ICON = '<svg class="iw-a2hs__ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>';
const ARROW = '<svg viewBox="0 0 40 56" aria-hidden="true"><path d="M20 4v40M8 32l12 14 12-14" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export class InstallPrompt {
  constructor() {
    this.deferred = window.__iwInstall || null;   // Chrome's beforeinstallprompt (index.html catches an early one)
    this.screen = 'boot';
    this.el = null;
    this._timer = 0;
    this.enabled = !standalone() && !load().installed && (isIOS || isAndroid || /[?&]a2hs\b/.test(location.search));
    if (!this.enabled) return;
    addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); this.deferred = e; if (this.el) this._render(); });
    addEventListener('appinstalled', () => { save({ installed: true }); this.enabled = false; this._hide(); });
    portraitMQ.addEventListener?.('change', () => this._update(300));
    this._update(0);   // at once: the game's loading keeps the main thread busy for a while after this
  }

  // called on every menu screen change (null = menus closed, e.g. in a match)
  setScreen(s) { this.screen = s; this._update(1200); }

  _update(delay) {
    if (!this._wanted()) { this._hide(); return; }
    if (this.el) { this._place(); this._render(); }
    else if (!delay) this._show(true);
    else if (!this._timer) this._timer = setTimeout(() => { this._timer = 0; if (this._wanted()) this._show(); }, delay);   // a pending one keeps its time
  }

  _wanted() {
    if (!this.enabled) return false;
    // portrait: the rotate screen covers the game, so any menu (or boot) will do — but never over a paused match
    if (portraitMQ.matches ? this.screen === null : !SCREENS.has(this.screen)) return false;
    const snoozed = load().snoozedAt;
    return !(snoozed && Date.now() - snoozed < SNOOZE_MS);
  }

  _show(now) {
    const el = document.createElement('div');
    el.className = 'iw-a2hs';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'ホーム画面に追加');
    // taps here must not reach the game (title "press to start", touch-mode switching)
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'touchstart', 'touchend', 'click']) el.addEventListener(t, (e) => e.stopPropagation());
    this.el = el;
    this._place();
    this._render();
    if (now) el.classList.add('is-on');   // no slide-in: the page is still busy loading and would stall it half-way
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-on'));
  }

  _place() { this.el.dataset.where = portraitMQ.matches && isIOS && !isIPad ? 'bottom' : 'top'; }

  _render() {
    const el = this.el;
    const oneTap = !!this.deferred;
    const shareAt = portraitMQ.matches && !isIPad ? '画面下' : '右上';
    const body = oneTap ? 'アドレスバーなしで、アプリのようにすぐ遊べます。'
      : isIOS ? `${shareAt}の ${SHARE_ICON}<b>共有</b>（または「…」→共有）→「<b>ホーム画面に追加</b>」`
      : `右上の ${MENU_ICON}<b>メニュー</b>→「<b>ホーム画面に追加</b>」`;
    el.innerHTML = `
      <div class="iw-a2hs__card">
        <button class="iw-a2hs__close" type="button" aria-label="閉じる">×</button>
        <img class="iw-a2hs__app" src="assets/icons/icon-192.png" alt="" width="48" height="48">
        <div class="iw-a2hs__text">
          <div class="iw-a2hs__title">ホーム画面に追加すると<br>全画面でプレイできます</div>
          <div class="iw-a2hs__body">${body}</div>
        </div>
        ${oneTap ? '<button class="iw-a2hs__go" type="button">追加する</button>' : ''}
      </div>
      ${oneTap ? '' : `<div class="iw-a2hs__arrow">${ARROW}</div>`}`;
    el.querySelector('.iw-a2hs__close').addEventListener('click', () => { save({ ...load(), snoozedAt: Date.now() }); this._hide(); });
    el.querySelector('.iw-a2hs__go')?.addEventListener('click', async () => {
      const e = this.deferred; this.deferred = null;
      if (!e) return;
      e.prompt();
      try {
        const { outcome } = await e.userChoice;
        if (outcome === 'accepted') { save({ installed: true }); this.enabled = false; }
        else save({ ...load(), snoozedAt: Date.now() });
      } catch { /* ignore */ }
      this._hide();
    });
  }

  _hide() {
    clearTimeout(this._timer); this._timer = 0;
    const el = this.el;
    if (!el) return;
    this.el = null;
    el.classList.remove('is-on');
    setTimeout(() => el.remove(), 300);
  }
}

export const installPrompt = new InstallPrompt();
