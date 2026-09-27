// INKWAVE friend-match relay: a Cloudflare Worker + one Durable Object per room.
//
// The game simulation runs in the browsers; this server only keeps the lobby (who is in the room, which team,
// the host's stage pick) and relays match traffic between the players of a room.
//
//   POST /rooms                → { code }                   create a room (5-character code)
//   GET  /rooms/:code          → { exists, phase, count }   peek (the join screen can say "room not found" early)
//   GET  /rooms/:code/ws?name=&weapon=&team=   WebSocket upgrade into the room
//
// Wire protocol (text frames):
//   '#…'        relay payload → forwarded unchanged to every other member of the room (match traffic, never parsed)
//   'ping'      → 'pong' (answered by the runtime without waking the object)
//   JSON        lobby control: { t: 'set' | 'config' | 'start' | 'end', … } (see Room.webSocketMessage)
// Server → client JSON: welcome · room · start · left · error
import { DurableObject } from 'cloudflare:workers';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1: codes are read aloud and typed on phones
const CODE_LEN = 5;
const TEAM_SIZE = 3;
const MAX_MEMBERS = TEAM_SIZE * 2;
const MAX_FRAME = 64 * 1024;
const IDLE_CLEANUP_MS = 15 * 60 * 1000;   // an empty room forgets itself after this long

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

function randomCode() {
  const b = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += CODE_ALPHABET[x % CODE_ALPHABET.length];
  return s;
}
const validCode = (c) => typeof c === 'string' && c.length === CODE_LEN && [...c].every((ch) => CODE_ALPHABET.includes(ch));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return json({ ok: true, service: 'inkwave-rooms' });
    if (parts[0] !== 'rooms') return json({ error: 'not_found' }, 404);

    if (parts.length === 1 && req.method === 'POST') {
      for (let i = 0; i < 8; i++) {
        const code = randomCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const r = await stub.fetch(`https://room/${code}/init`, { method: 'POST' });
        if (r.ok) return json({ code });
      }
      return json({ error: 'busy' }, 503);
    }

    const code = (parts[1] || '').toUpperCase();
    if (!validCode(code)) return json({ error: 'bad_code' }, 400);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    if (parts.length === 2 && req.method === 'GET') {
      const r = await stub.fetch(`https://room/${code}/info`);
      return json(await r.json(), r.status);
    }
    if (parts.length === 3 && parts[2] === 'ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426);
      return stub.fetch(new Request(`https://room/${code}/ws${url.search}`, req));
    }
    return json({ error: 'not_found' }, 404);
  },
};

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.meta = null;
    ctx.blockConcurrencyWhile(async () => { this.meta = (await ctx.storage.get('meta')) || null; });
    // keep-alive pings never wake a hibernated room
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async _save() { await this.ctx.storage.put('meta', this.meta); }

  // live members = open sockets (their attachment carries the member record, so it survives hibernation)
  _members() {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const m = ws.deserializeAttachment();
      if (m && ws.readyState === 1) out.push({ ws, m });
    }
    return out.sort((a, b) => a.m.id - b.m.id);
  }

  _roomState() {
    const ms = this._members();
    return {
      t: 'room', code: this.meta.code, host: this.meta.host, phase: this.meta.phase, config: this.meta.config,
      members: ms.map(({ m }) => ({ id: m.id, name: m.name, team: m.team, weapon: m.weapon, style: m.style })),
    };
  }

  _broadcast(obj, except = null) {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    for (const { ws } of this._members()) if (ws !== except) { try { ws.send(s); } catch { /* closing */ } }
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [, code, action] = url.pathname.split('/');
    if (action === 'init') {
      if (this.meta) return json({ error: 'exists' }, 409);
      this.meta = { code, created: Date.now(), host: 0, nextId: 1, phase: 'lobby', config: { mapId: null, time: 'day' } };
      await this._save();
      await this.ctx.storage.setAlarm(Date.now() + IDLE_CLEANUP_MS);
      return json({ ok: true });
    }
    if (action === 'info') {
      if (!this.meta) return json({ exists: false }, 404);
      return json({ exists: true, phase: this.meta.phase, count: this._members().length });
    }
    if (action !== 'ws') return json({ error: 'not_found' }, 404);
    if (!this.meta) return json({ error: 'no_room' }, 404);
    const ms = this._members();
    const refuse = (error) => {
      // hand the reason over the socket: a browser can't read an HTTP error body on a failed upgrade
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({ t: 'error', error }));
      pair[1].close(4000, error);
      return new Response(null, { status: 101, webSocket: pair[0] });
    };
    if (ms.length >= MAX_MEMBERS) return refuse('full');
    if (this.meta.phase === 'match') return refuse('in_match');

    const q = url.searchParams;
    const counts = [0, 0];
    for (const { m } of ms) counts[m.team]++;
    let team = q.get('team') === '1' ? 1 : q.get('team') === '0' ? 0 : (counts[0] <= counts[1] ? 0 : 1);
    if (counts[team] >= TEAM_SIZE) team = 1 - team;
    const member = {
      id: this.meta.nextId++, name: clean(q.get('name'), 16) || 'Player', team,
      weapon: clean(q.get('weapon'), 24) || 'shooter', style: null,
    };
    if (!this.meta.host || !ms.some(({ m }) => m.id === this.meta.host)) this.meta.host = member.id;
    await this._save();
    await this.ctx.storage.deleteAlarm();

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(member);
    pair[1].send(JSON.stringify({ t: 'welcome', id: member.id }));
    this._broadcast(this._roomState());
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > MAX_FRAME) return;
    const me = ws.deserializeAttachment();
    if (!me) return;
    // match traffic: forward untouched
    if (msg.charCodeAt(0) === 35 /* # */) { this._broadcast(msg, ws); return; }
    let o;
    try { o = JSON.parse(msg); } catch { return; }
    if (!o || typeof o !== 'object') return;
    const isHost = me.id === this.meta.host;
    switch (o.t) {
      case 'set': {
        if ('name' in o) me.name = clean(o.name, 16) || me.name;
        if ('weapon' in o) me.weapon = clean(o.weapon, 24) || me.weapon;
        if ('style' in o && (o.style === null || typeof o.style === 'object')) {
          const st = JSON.stringify(o.style);
          if (st.length < 600) me.style = o.style;
        }
        if ((o.team === 0 || o.team === 1) && o.team !== me.team && this.meta.phase === 'lobby') {
          const n = this._members().filter(({ m }) => m.team === o.team).length;
          if (n < TEAM_SIZE) me.team = o.team;
          else ws.send(JSON.stringify({ t: 'error', error: 'team_full' }));
        }
        ws.serializeAttachment(me);
        this._broadcast(this._roomState());
        break;
      }
      case 'config':
        if (!isHost || this.meta.phase !== 'lobby') break;
        if (typeof o.mapId === 'string') this.meta.config.mapId = clean(o.mapId, 24);
        if (o.time === 'day' || o.time === 'dusk') this.meta.config.time = o.time;
        await this._save();
        this._broadcast(this._roomState());
        break;
      case 'start': {
        if (!isHost || this.meta.phase !== 'lobby') break;
        const s = JSON.stringify(o);
        if (s.length > MAX_FRAME) break;
        this.meta.phase = 'match';
        await this._save();
        this._broadcast(s);                  // everyone, the host included, starts from the same payload
        this._broadcast(this._roomState());
        break;
      }
      case 'end':
        if (!isHost) break;
        this.meta.phase = 'lobby';
        await this._save();
        this._broadcast(this._roomState());
        break;
    }
  }

  async _leave(ws) {
    const me = ws.deserializeAttachment();
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    if (!me || !this.meta) return;
    ws.serializeAttachment(null);
    const rest = this._members().filter((x) => x.ws !== ws);
    if (me.id === this.meta.host) this.meta.host = rest.length ? rest[0].m.id : 0;
    if (!rest.length) {
      this.meta.phase = 'lobby';
      await this.ctx.storage.setAlarm(Date.now() + IDLE_CLEANUP_MS);
    }
    await this._save();
    this._broadcast({ t: 'left', id: me.id, host: this.meta.host });
    this._broadcast(this._roomState());
  }

  async webSocketClose(ws) { await this._leave(ws); }
  async webSocketError(ws) { await this._leave(ws); }

  async alarm() {
    if (this._members().length) return;
    await this.ctx.storage.deleteAll();
    this.meta = null;
  }
}
