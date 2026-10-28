'use strict';
// Traitor: Zombie Amongst Us - private UDP game server (runs in Termux on the phone, or any UDP host).
// usage: node udp-server.js        (env: PORT=40000, LOG_URL=https://traitor-server-5.onrender.com)
const { NetcodeServer } = require('./netcode');
const { readRoot, buildBuffer, F, W } = require('./fb');

const PORT = Number(process.env.PORT || 40000);
const LOG_URL = process.env.LOG_URL || 'https://traitor-server-5.onrender.com';

// ---------------------------------------------------------------- logging (console + forwarded to Render logs)
const queue = [];
function log(msg) {
  const line = new Date().toISOString().slice(11, 23) + ' ' + msg;
  console.log(line); queue.push(line); if (queue.length > 400) queue.shift();
}
setInterval(async () => {
  if (!queue.length) return;
  const lines = queue.splice(0, 60);
  try { await fetch(LOG_URL + '/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lines }) }); }
  catch (e) { /* offline: drop */ }
}, 1500);
const hex = (b, n = 80) => Buffer.from(b).subarray(0, n).toString('hex') + (b.length > n ? '...' : '');

// ---------------------------------------------------------------- game endpoints (UDPPackets enum)
const EP = { Handshake: 0, HandshakeAck: 1, Ping: 2, Pong: 3, InputState: 4, WorldState: 5, ChatMessage: 12, Ack: 19, JoinMatch: 20, PlayerJoin: 21, PlayerDisconnect: 22, GameStart: 23, GameEnd: 24, StartingSoon: 44, UpdateRoomSettings: 50 };
const EPNAME = Object.fromEntries(Object.entries(EP).map(([k, v]) => [v, k]));

// ---------------------------------------------------------------- wire framing: Segments{ seq, segNo, total, last, reliable, data=UDPPacket }
function packetTable(ep, uid, payload, seq) { return [W.u8(ep), F.str(uid), F.bytes(payload), F.u16(seq)]; }
function udpPacket(packets, reliable) { return buildBuffer([F.bool(reliable), F.tvec(packets)]); }
function segment(data, seq, reliable) {
  // Segments: 0 SequenceID(u16) 1 SegmentNumber(u8) 2 TotalSegments(u8) 3 LastSegment(bool) 4 Reliable(bool) 5 Data(bytes)
  return buildBuffer([F.u16(seq), F.u8(0), W.u8(1), F.bool(true), F.bool(reliable), F.bytes(data)]);
}

// ---------------------------------------------------------------- world simulation
const SPAWN = { x: Number(process.env.SPAWN_X || 0), y: Number(process.env.SPAWN_Y || 0) };
const SPEED = Number(process.env.SPEED || 3);          // world units per second at full stick (tune from rubber-banding)
const INPUT_DT = Number(process.env.INPUT_DT || 1 / 30); // seconds covered by one input sample
const TICK_MS = 50;                                      // WorldState broadcast rate (20 Hz)
let inputLogs = 0;

// ---------------------------------------------------------------- rooms
const rooms = new Map();
function getRoom(id, mode) {
  let r = rooms.get(id);
  if (!r) { r = { id, mode: mode || 0, players: [], host: 1, started: false }; rooms.set(id, r); log(`room ${id} created mode=${mode}`); }
  return r;
}
function settingsTable(room) {
  // OnlineGameSettings slots 0..21 (see dump)
  const v = [1, 10, 1, 5, 3, 3, 30, 10, 10, 15, 30, 3, 10, 5, 10, 8, 12, 12, room.mode, 10, 10, 0];
  return v.map((x) => W.u8(x));
}
function playerTable(p) {
  // Player: 0 Number 1 Color 2 Imposter 3 Name 4 Hat 5 Pet 6 SessionID 7 Eyewear 8 Costume
  return [W.u8(p.number), W.u8(p.color), F.bool(false), F.str(p.name), W.u8(0), W.u8(0), F.str(p.session), W.u8(0), W.u8(0)];
}

// ---------------------------------------------------------------- server
const server = new NetcodeServer({ port: PORT, log });

function sendPackets(c, packets, reliable = false, quiet = false) {
  c.seq = ((c.seq || 0) + 1) & 0xffff;
  const inner = udpPacket(packets.map((p) => packetTable(p.ep, '', p.payload || Buffer.alloc(0), (c.pseq = ((c.pseq || 0) + 1) & 0xffff))), reliable);
  const seg = segment(inner, c.seq, reliable);
  server.send(c, seg);
  if (!quiet) for (const p of packets) log(`>> ${EPNAME[p.ep] ?? p.ep} ${hex(p.payload || [])}`);
}

server.on('connect', (c) => {
  let ud = {}; try { ud = JSON.parse(c.userData.toString('utf8').replace(/\0+$/, '')); } catch (e) {}
  c.info = ud; c.recv = new Set();
  const room = getRoom(ud.r || 'ROOM01', ud.m);
  // player numbers are 1-based in the game client (it indexes lists with number-1)
  let number = 1; const taken = new Set(room.players.map((p) => p.number)); while (taken.has(number)) number++;
  c.player = { number, color: (number - 1) % 12, name: ud.n || ('Player' + number), session: ud.u || String(c.clientId), client: c, x: SPAWN.x, y: SPAWN.y, pred: 0 };
  room.players.push(c.player); c.room = room;
  log(`player ${c.player.name} joined room ${room.id} as #${number} userData=${JSON.stringify(ud)}`);
});
server.on('disconnect', (c) => {
  if (c.room) { c.room.players = c.room.players.filter((p) => p.client !== c); log(`player left room ${c.room.id}`); if (!c.room.players.length) rooms.delete(c.room.id); }
});

server.on('data', (c, data) => {
  let seg; try { seg = readRoot(data); } catch (e) { log('bad segment ' + hex(data)); return; }
  const sInfo = { seq: seg.u16(0), no: seg.u8(1), total: seg.u8(2), last: seg.bool(3), rel: seg.bool(4) };
  const inner = seg.bytes(5);
  log(`<< segment ${JSON.stringify(sInfo)} dataLen=${inner.length}`);
  if (sInfo.total > 1) { log('multi-segment message not supported yet'); return; }
  let pk; try { pk = readRoot(inner); } catch (e) { log('bad udppacket ' + hex(inner)); return; }
  const reliable = pk.bool(0);
  for (const p of pk.tvec(1)) {
    const ep = p.u8(0), payload = p.bytes(2), seq = p.u16(3);
    c.recv.add(seq);
    log(`<< ${EPNAME[ep] ?? 'ep' + ep} (${ep}) uid=${p.str(1)} seq=${seq} rel=${reliable} payload=${hex(payload)}`);
    handle(c, ep, payload, seq);
  }
  if (reliable) sendAck(c, sInfo.seq);
});

function sendAck(c, last) {
  let bits = 0; for (let i = 0; i < 32; i++) if (c.recv.has((last - 1 - i) & 0xffff)) bits |= (1 << i);
  const ack = buildBuffer([F.u32(bits >>> 0), F.u16(last)]);
  sendPackets(c, [{ ep: EP.Ack, payload: ack }]);
}

function handle(c, ep, payload, seq) {
  switch (ep) {
    case EP.Handshake: sendPackets(c, [{ ep: EP.HandshakeAck, payload: Buffer.alloc(0) }]); break;
    case EP.Ping: sendPackets(c, [{ ep: EP.Pong, payload: Buffer.alloc(0) }]); break;
    case EP.JoinMatch: joinMatch(c, payload); break;
    case EP.InputState: onInput(c, payload); break;
    case EP.ChatMessage: onChat(c, payload); break;
    default: break; // logged above; add handlers as the protocol becomes clear
  }
}

function onChat(c, payload) {
  // ChatMessage: 0 PlayerNumber(u8) 1 Message(string) 2 Time(u64)
  const t = readRoot(payload); const msg = t.str(1);
  log(`chat #${c.player.number} ${c.player.name}: ${msg}`);
  const out = buildBuffer([W.u8(c.player.number), F.str(msg), F.u64(Date.now())]);
  for (const p of c.room.players) sendPackets(p.client, [{ ep: EP.ChatMessage, payload: out }]);
}

function onInput(c, payload) {
  const t = readRoot(payload); const start = t.u32(0); const inputs = t.tvec(1); const p = c.player;
  if (inputLogs < 6) { inputLogs++; log(`input start=${start} n=${inputs.length} ` + inputs.slice(0, 4).map((v) => `(${v.f32(0).toFixed(2)},${v.f32(1).toFixed(2)})`).join(' ')); }
  // every packet re-sends the last 2-4 samples (loss protection) -> only apply ids we have not seen yet
  inputs.forEach((v, i) => {
    const id = (start + i) >>> 0;
    if (p.lastInput !== undefined && id <= p.lastInput && p.lastInput - id < 100000) return;
    p.x += v.f32(0) * SPEED * INPUT_DT; p.y += v.f32(1) * SPEED * INPUT_DT; p.lastInput = id;
  });
  p.pred = p.lastInput >>> 0;
}

function worldState(room, forClient) {
  // WorldState: 0 PlayerStates[]   PlayerState: 0 PlayerIndex(u8) 1 X(f64) 2 Y(f64) 3 PredictionID(u32)
  return buildBuffer([F.tvec(room.players.map((p) => [W.u8(p.number), F.f64(p.x), F.f64(p.y), F.u32(p.pred)]))]);
}
setInterval(() => {
  for (const room of rooms.values()) {
    for (const p of room.players) {
      try { sendPackets(p.client, [{ ep: EP.WorldState, payload: worldState(room, p.client) }], false, true); } catch (e) {}
    }
  }
}, TICK_MS);

// ---------------------------------------------------------------- lobby -> game start (formats guessed from the client code)
const START_DELAY_MS = Number(process.env.START_DELAY_MS || 12000);   // wait in the lobby before starting
const AUTO_START = process.env.AUTO_START !== '0';
function finalSettings(room) { // FinalGameSettings: 0 NumImposters 1 MaxPlayers 2 MinPlayers 3 GameEndTime (all u8)
  return [W.u8(room.players.length >= 3 ? 1 : 0), W.u8(10), W.u8(1), W.u8(5)];
}
function broadcast(room, ep, payload) { for (const p of room.players) sendPackets(p.client, [{ ep, payload }]); }
function scheduleStart(room) {
  if (!AUTO_START || room.timer || room.started) return;
  room.timer = setTimeout(() => {
    room.timer = null; if (!room.players.length) return;
    log(`room ${room.id}: wait over, ${room.players.length} player(s) -> UpdateRoomSettings + StartingSoon`);
    broadcast(room, EP.UpdateRoomSettings, buildBuffer(finalSettings(room)));
    setTimeout(() => broadcast(room, EP.StartingSoon, buildBuffer([])), 1500);
    setTimeout(() => {
      if (!room.players.length) return; room.started = true;
      const n = room.players.length;
      const imps = n >= 3 ? [room.players[Math.floor(Math.random() * n)].number] : [];
      const tasks = [0, 1, 2, 3];
      const gs = buildBuffer([F.bytes(Buffer.from(imps)), F.bytes(Buffer.from(tasks)), W.i32(tasks.length * n), null, F.table(finalSettings(room))]);
      log(`room ${room.id}: GameStart imposters=${JSON.stringify(imps)} tasks=${tasks}`);
      broadcast(room, EP.GameStart, gs);
    }, 5000);
  }, START_DELAY_MS);
}

function joinMatch(c, payload) {
  const room = c.room;
  // JoinMatchAck: 0 Success 1 Message 2 PlayerIndex 3 RoomID 4 GameSettings 5 CurrentGameState 6 Private 7 HostPlayerNumber 8..13 voice strings
  const ack = buildBuffer([
    W.bool(true), F.str(''), W.u8(c.player.number), F.str(room.id),
    F.table(settingsTable(room)), F.table([F.tvec(room.players.map(playerTable))]),
    F.bool(!!c.info.p), W.u8(room.host),
    F.str(''), F.str(''), F.str(''), F.str(''), F.str(''), F.str(''),
  ]);
  sendPackets(c, [{ ep: EP.JoinMatch + 0, payload: ack }]);
  scheduleStart(room);
  const others = room.players.filter((p) => p.client !== c);
  if (others.length) { const pj = buildBuffer([F.tvec([playerTable(c.player)])]); for (const o of others) sendPackets(o.client, [{ ep: EP.PlayerJoin, payload: pj }]); }
}

server.start();
setInterval(() => log(`alive rx=${server.rx} clients=${server.clients.size} pending=${server.pending.size} rooms=${rooms.size}`), 10000);
log('traitor udp server started on ' + PORT);
