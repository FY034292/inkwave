// Friend match: the host turns the room (who is in which team) into the start payload every machine builds the
// same match from — six squidkids in fixed slots, CPUs in the empty ones, one palette, one stage.
import { WEAPONS, WEAPON_ORDER, BOT_NAMES, MATCH, TEAM_PALETTES, MAPS } from '../config.js';
import { randomStyle } from '../game/character-style.js';

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** room: the relay's room state · returns [{ id, team, slot, name, weapon, style, owner, bot }] (id = team·size + slot) */
export function buildRoster(room) {
  const N = MATCH.teamSize;
  const teams = [[], []];
  for (const m of [...room.members].sort((a, b) => a.id - b.id)) {
    const t = m.team === 1 ? 1 : 0;
    if (teams[t].length < N) teams[t].push(m);
    else if (teams[1 - t].length < N) teams[1 - t].push(m);
  }
  const taken = new Set(room.members.map((m) => m.name));
  const names = shuffle(BOT_NAMES.filter((n) => !taken.has(n)));
  let ni = 0;
  const roster = [];
  for (let team = 0; team < 2; team++) {
    // CPUs fill in the weapons the humans on that team didn't bring (a balanced mix, like a local match)
    const pool = shuffle(WEAPON_ORDER.filter((w) => !teams[team].some((m) => m.weapon === w)));
    for (let slot = 0; slot < N; slot++) {
      const m = teams[team][slot];
      const id = team * N + slot;
      if (m) {
        roster.push({ id, team, slot, name: m.name, weapon: WEAPONS[m.weapon] ? m.weapon : 'shooter', style: m.style || randomStyle(), owner: m.id, bot: false });
      } else {
        if (!pool.length) pool.push(...shuffle([...WEAPON_ORDER]));
        roster.push({ id, team, slot, name: names[ni++ % names.length] || `CPU ${id + 1}`, weapon: pool.pop(), style: randomStyle(), owner: room.host, bot: true });
      }
    }
  }
  return roster;
}

export function startPayload(room) {
  const cfg = room.config || {};
  const map = MAPS.find((m) => m.id === cfg.mapId) || MAPS[0];
  return {
    host: room.host,
    mapId: map.id,
    time: cfg.time === 'dusk' ? 'dusk' : 'day',
    palette: (Math.random() * TEAM_PALETTES.length) | 0,
    duration: MATCH.defaultDuration,
    roster: buildRoster(room),
  };
}
