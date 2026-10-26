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
const EP = { Handshake: 0, HandshakeAck: 1, Ping: 2, Pong: 3, InputState: 4, WorldState: 5, Ack: 19, JoinMatch: 20, PlayerJoin: 21, PlayerDisconnect: 22, GameStart: 23, GameEnd: 24 };
const EPNAME = Object.fromEntries(Object.entries(EP).map(([k, v]) => [v, k]));

// ---------------------------------------------------------------- wire framing: Segments{ seq, segNo, total, last, reliable, data=UDPPacket }
function packetTable(ep, uid, payload, seq) { return [W.u8(ep), F.str(uid), F.bytes(payload), F.u16(seq)]; }
function udpPacket(packets, reliable) { return buildBuffer([F.bool(reliable), F.tvec(packets)]); }
function segment(data, seq, reliable) {
  // Segments: 0 SequenceID(u16) 1 SegmentNumber(u8) 2 TotalSegments(u8) 3 LastSegment(bool) 4 Reliable(bool) 5 Data(bytes)
  return buildBuffer([F.u16(seq), F.u8(0), W.u8(1), F.bool(true), F.bool(reliable), F.bytes(data)]);
}

// ---------------------------------------------------------------- rooms
const rooms = new Map();
function getRoom(id, mode) {
  let r = rooms.get(id);
  if (!r) { r = { id, mode: mode || 0, players: [], host: 0, started: false }; rooms.set(id, r); log(`room ${id} created mode=${mode}`); }
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

function sendPackets(c, packets, reliable = false) {
  c.seq = ((c.seq || 0) + 1) & 0xffff;
  const inner = udpPacket(packets.map((p) => packetTable(p.ep, '', p.payload || Buffer.alloc(0), (c.pseq = ((c.pseq || 0) + 1) & 0xffff))), reliable);
  const seg = segment(inner, c.seq, reliable);
  server.send(c, seg);
  for (const p of packets) log(`>> ${EPNAME[p.ep] ?? p.ep} ${hex(p.payload || [])}`);
}

server.on('connect', (c) => {
  let ud = {}; try { ud = JSON.parse(c.userData.toString('utf8').replace(/\0+$/, '')); } catch (e) {}
  c.info = ud; c.recv = new Set();
  const room = getRoom(ud.r || 'ROOM01', ud.m);
  const number = room.players.length;
  c.player = { number, color: number % 12, name: ud.n || ('Player' + (number + 1)), session: ud.u || String(c.clientId), client: c };
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
    default: break; // logged above; add handlers as the protocol becomes clear
  }
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
}

server.start();
setInterval(() => log(`alive rx=${server.rx} clients=${server.clients.size} pending=${server.pending.size} rooms=${rooms.size}`), 10000);
log('traitor udp server started on ' + PORT);
