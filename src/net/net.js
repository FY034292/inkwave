// Friend-match connection: talks to the room relay (server/ — a Cloudflare Worker + Durable Object per room).
//
//   const net = new NetClient(serverUrl);
//   const code = await net.create();                 // new room → code (then join it)
//   await net.join(code, { name, weapon, style });   // resolves once the room has welcomed us
//   net.on('room' | 'start' | 'relay' | 'left' | 'close' | 'error', fn) → unsubscribe
//   net.set({ team, weapon, name, style }) · net.config({ mapId, time, cpu }) · net.start(payload) · net.end()
//   net.relay(string)                                // match traffic, forwarded as-is to everyone else in the room
//   net.leave()
// The room state (net.room) mirrors the server: { code, host, phase: 'lobby' | 'match', config, members[] }.
import { NET } from '../config.js';

export const ERROR_TEXT = {
  no_server: '対戦サーバーが設定されていません。',
  no_room: 'ルームが見つかりません。コードを確認してください。',
  bad_code: 'ルームコードが正しくありません。',
  full: 'ルームが満員です（最大6人）。',
  in_match: 'このルームは対戦中です。終わるまで待ってから参加してください。',
  team_full: 'そのチームは満員です。',
  connect: 'サーバーに接続できませんでした。',
  lost: 'サーバーとの接続が切れました。',
  busy: 'サーバーが混み合っています。少し待ってからもう一度お試しください。',
};

/** Where the room server lives: ?server=… → localStorage 'inkwave.server' → NET.server → a local `wrangler dev` (8787)
 *  when the game itself is served from this machine or the LAN. '' = not configured. */
export function resolveServer() {
  try {
    const q = new URLSearchParams(location.search).get('server');
    if (q) return q.replace(/\/+$/, '');
  } catch { /* no location (tools) */ }
  try { const s = localStorage.getItem('inkwave.server'); if (s) return s.replace(/\/+$/, ''); } catch { /* private mode */ }
  if (NET.server) return NET.server.replace(/\/+$/, '');
  const h = typeof location !== 'undefined' ? location.hostname : '';
  if (h === 'localhost' || h === '127.0.0.1' || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(h)) return `http://${h}:8787`;
  return '';
}

// room codes use A–Z and 2–9 without the look-alikes I, O, 0, 1 (server/src/index.js CODE_ALPHABET)
export const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, NET.codeLength);

export class NetClient {
  constructor(server = resolveServer()) {
    this.server = server;
    this.ws = null;
    this.myId = 0;
    this.room = null;
    this.code = '';
    this._ls = new Map();
    this._ping = 0;
    this._closing = false;
  }

  get connected() { return !!(this.ws && this.ws.readyState === 1 && this.myId); }
  get isHost() { return !!(this.room && this.myId && this.room.host === this.myId); }
  get me() { return this.room?.members.find((m) => m.id === this.myId) || null; }

  on(name, fn) {
    if (!this._ls.has(name)) this._ls.set(name, new Set());
    this._ls.get(name).add(fn);
    return () => this._ls.get(name)?.delete(fn);
  }
  _emit(name, v) { const s = this._ls.get(name); if (s) for (const fn of [...s]) { try { fn(v); } catch (e) { console.error('[net]', name, e); } } }

  async create() {
    if (!this.server) throw netError('no_server');
    let r;
    try { r = await fetch(`${this.server}/rooms`, { method: 'POST' }); }
    catch { throw netError('connect'); }
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.code) throw netError(body.error || 'connect');
    return body.code;
  }

  join(code, { name = 'Player', weapon = 'shooter', style = null, team = null } = {}) {
    if (!this.server) return Promise.reject(netError('no_server'));
    this.leave();
    this._closing = false;
    this.code = code;
    const q = new URLSearchParams({ name, weapon });
    if (team === 0 || team === 1) q.set('team', String(team));
    const url = `${this.server.replace(/^http/, 'ws')}/rooms/${encodeURIComponent(code)}/ws?${q}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (code) => { if (!settled) { settled = true; reject(netError(code)); } };
      let ws;
      try { ws = new WebSocket(url); } catch { fail('connect'); return; }
      this.ws = ws;
      const timer = setTimeout(() => { fail('connect'); try { ws.close(); } catch { /* */ } }, 10000);
      ws.onmessage = (ev) => {
        const s = ev.data;
        if (typeof s !== 'string') return;
        if (s.charCodeAt(0) === 35) { this._emit('relay', s.slice(1)); return; }
        if (s === 'pong') return;
        let o; try { o = JSON.parse(s); } catch { return; }
        switch (o.t) {
          case 'welcome':
            this.myId = o.id;
            if (style) this.send({ t: 'set', style });
            break;
          case 'room': {
            const prevHost = this.room?.host;
            this.room = o;
            if (!settled && this.myId) { settled = true; clearTimeout(timer); resolve(this); }
            this._emit('room', o);
            if (prevHost && prevHost !== o.host) this._emit('host', o.host);
            break;
          }
          case 'start': this._emit('start', o); break;
          case 'left': this._emit('left', o); break;
          case 'error':
            if (!settled) { clearTimeout(timer); fail(o.error); }
            else this._emit('error', netError(o.error));
            break;
        }
      };
      ws.onerror = () => { clearTimeout(timer); fail('connect'); };
      ws.onclose = () => {
        clearTimeout(timer);
        clearInterval(this._ping);
        if (this.ws === ws) { this.ws = null; const was = this.myId; this.myId = 0; this.room = null; if (was && !this._closing) this._emit('close', netError('lost')); }
        fail('connect');
      };
      ws.onopen = () => {
        clearInterval(this._ping);
        this._ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 20000);
      };
    });
  }

  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  relay(str) { if (this.ws && this.ws.readyState === 1) this.ws.send('#' + str); }
  set(fields) { this.send({ t: 'set', ...fields }); }
  config(cfg) { this.send({ t: 'config', ...cfg }); }
  start(payload) { this.send({ ...payload, t: 'start' }); }
  end() { this.send({ t: 'end' }); }

  leave() {
    clearInterval(this._ping);
    const ws = this.ws;
    this._closing = true;
    this.ws = null; this.myId = 0; this.room = null;
    if (ws) { try { ws.close(1000, 'leave'); } catch { /* */ } }
  }
}

function netError(code) {
  const e = new Error(ERROR_TEXT[code] || ERROR_TEXT.connect);
  e.code = code;
  return e;
}
