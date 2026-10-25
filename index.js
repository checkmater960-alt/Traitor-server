// Traitor: Zombie Amongst Us (v0.12.04) - private server emulator (WebSocket + FlatBuffers)
// Only dependency: ws.  Deploy on Render as a Web Service (build: npm install, start: node index.js)
//
// Wire format (from Assembly-CSharp dump): every WS binary message is a FlatBuffers `Packets.Packet`
//   Packet { 0 Service:string, 1 Endpoint:string, 2 Payload:[ubyte], 3 SequenceID:int,
//            4 UserID:string, 5 DeviceID:string, 6 IP:string, 7 Country:string }
// The Payload itself is another FlatBuffers table (RouterJoin, UserGet, UserGetResponse ...).
// Slot numbers are the order of the generated Create*/Add* methods, so they should match.
//
// NOTE: real service/endpoint names are NOT visible in dump.cs, so every packet is logged.
// Run the game once, read the Render logs, and set the env vars below to the real names.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROUTER_ACK_ENDPOINT = process.env.ROUTER_ACK_ENDPOINT || 'RouterJoinAck';
const USERGET_RESP_ENDPOINT = process.env.USERGET_RESP_ENDPOINT || 'UserGetResponse';
const MATCH_ROUTER_JOIN = new RegExp(process.env.MATCH_ROUTER_JOIN || 'routerjoin', 'i');
const MATCH_USER_GET = new RegExp(process.env.MATCH_USER_GET || '^userget$', 'i');

// ---------------------------------------------------------------- FlatBuffers reader
function readTable(buf, pos) {
  const vt = pos - buf.readInt32LE(pos);
  const vtSize = buf.readUInt16LE(vt);
  const field = (slot) => {
    const o = 4 + slot * 2;
    if (o >= vtSize) return 0;
    const rel = buf.readUInt16LE(vt + o);
    return rel ? pos + rel : 0;
  };
  return {
    str(slot) {
      const f = field(slot);
      if (!f) return '';
      const p = f + buf.readUInt32LE(f);
      return buf.toString('utf8', p + 4, p + 4 + buf.readUInt32LE(p));
    },
    bytes(slot) {
      const f = field(slot);
      if (!f) return Buffer.alloc(0);
      const p = f + buf.readUInt32LE(f);
      return buf.subarray(p + 4, p + 4 + buf.readUInt32LE(p));
    },
    i8: (slot) => { const f = field(slot); return f ? buf.readInt8(f) : 0; },
    i32: (slot) => { const f = field(slot); return f ? buf.readInt32LE(f) : 0; },
  };
}
const readRoot = (buf) => readTable(buf, buf.readUInt32LE(0));

// ---------------------------------------------------------------- FlatBuffers writer (forward-built)
// fields: array indexed by slot; entry = null | {t, v}
// t: 'bool' | 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'str' | 'bytes' | 'table'
// for 'table', v is itself a fields array.
const SIZE = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, str: 4, bytes: 4, table: 4 };

function buildBuffer(rootFields) {
  const chunks = [Buffer.alloc(8)]; // [0..4) root offset, [4..8) padding (keeps 8-byte alignment)
  let len = 8;
  const push = (b) => { chunks.push(b); len += b.length; };
  const align = (n) => { const pad = (n - (len % n)) % n; if (pad) push(Buffer.alloc(pad)); };
  const patches = []; // {at, target}

  function writeString(s) {
    align(4);
    const data = Buffer.from(s, 'utf8');
    const pos = len;
    const b = Buffer.alloc(4); b.writeUInt32LE(data.length); push(b);
    push(data); push(Buffer.alloc(1));
    return pos;
  }
  function writeBytes(data) {
    align(4);
    const pos = len;
    const b = Buffer.alloc(4); b.writeUInt32LE(data.length); push(b);
    push(Buffer.from(data));
    return pos;
  }
  function writeTable(fields) {
    // layout inside the table (offset 0 = soffset)
    let off = 4; const rel = [];
    let maxAlign = 4;
    fields.forEach((f, slot) => {
      if (!f) { rel[slot] = 0; return; }
      const sz = SIZE[f.t];
      if (sz > maxAlign) maxAlign = sz;
      off = Math.ceil(off / sz) * sz;
      rel[slot] = off; off += sz;
    });
    const tableSize = off;
    // vtable
    align(2);
    const vtPos = len;
    const vt = Buffer.alloc(4 + rel.length * 2);
    vt.writeUInt16LE(vt.length, 0); vt.writeUInt16LE(tableSize, 2);
    rel.forEach((r, i) => vt.writeUInt16LE(r || 0, 4 + i * 2));
    push(vt);
    align(maxAlign);
    const tPos = len;
    const tb = Buffer.alloc(tableSize);
    tb.writeInt32LE(tPos - vtPos, 0);
    const children = [];
    fields.forEach((f, slot) => {
      if (!f) return;
      const o = rel[slot];
      switch (f.t) {
        case 'bool': case 'u8': tb.writeUInt8(f.v ? Number(f.v) : 0, o); break;
        case 'i8': tb.writeInt8(f.v, o); break;
        case 'u16': tb.writeUInt16LE(f.v, o); break;
        case 'i16': tb.writeInt16LE(f.v, o); break;
        case 'u32': tb.writeUInt32LE(f.v, o); break;
        case 'i32': tb.writeInt32LE(f.v, o); break;
        case 'u64': tb.writeBigUInt64LE(BigInt(f.v), o); break;
        default: children.push({ at: tPos + o, f });
      }
    });
    push(tb);
    for (const c of children) {
      let target;
      if (c.f.t === 'str') target = writeString(c.f.v);
      else if (c.f.t === 'bytes') target = writeBytes(c.f.v);
      else target = writeTable(c.f.v);
      patches.push({ at: c.at, target });
    }
    return tPos;
  }

  const root = writeTable(rootFields);
  const out = Buffer.concat(chunks, len);
  out.writeUInt32LE(root, 0);
  for (const p of patches) out.writeUInt32LE(p.target - p.at, p.at);
  return out;
}

// ---------------------------------------------------------------- Packet helpers
const S = (v) => ({ t: 'str', v });
function makePacket(service, endpoint, payload, sequenceId, userId) {
  const f = [];
  f[0] = S(service); f[1] = S(endpoint);
  f[2] = { t: 'bytes', v: payload || Buffer.alloc(0) };
  if (sequenceId) f[3] = { t: 'i32', v: sequenceId };
  if (userId) f[4] = S(userId);
  for (let i = 0; i < 8; i++) if (!f[i]) f[i] = null;
  return buildBuffer(f);
}
function parsePacket(buf) {
  const t = readRoot(buf);
  return {
    service: t.str(0), endpoint: t.str(1), payload: t.bytes(2),
    sequenceId: t.i32(3), userId: t.str(4), deviceId: t.str(5),
  };
}

// UserGetResponse: 0 ID, 1 Name, 2 GameCode, 3 HasUpdate, 4 UpdateMsg, 5 ClientSettings(table),
//                  6 NewUser, 7 ReferralLevelClaims(u32), 8 ServerTime(u64), 9 ADCohorts(u16)
// ClientSettingsTable: 0 RateUsPopup(bool), 1 VoiceChatEnabled(bool)
function makeUserGetResponse(id, name) {
  const f = [];
  f[0] = S(id);
  f[1] = S(name || 'Player');
  f[2] = S(crypto.randomBytes(3).toString('hex').toUpperCase());
  f[3] = null;                                           // HasUpdate = false
  f[4] = S('');
  f[5] = { t: 'table', v: [null, null] };                // all settings off (no rate popup, no voice chat)
  f[6] = null;                                           // NewUser = false
  f[7] = null;                                           // ReferralLevelClaims = 0
  f[8] = { t: 'u64', v: Date.now() };
  f[9] = null;                                           // ADCohorts = 0
  return buildBuffer(f);
}

// ---------------------------------------------------------------- server
const server = http.createServer((req, res) => { res.writeHead(200); res.end('traitor emulator ok\n'); });
const wss = new WebSocketServer({ server }); // accepts any path, including /ws

const hex = (b, n = 96) => b.subarray(0, n).toString('hex') + (b.length > n ? '...' : '');

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  console.log(`[+] connect path=${req.url} ip=${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
  let playerId = null;

  const send = (service, endpoint, payload, seq) => {
    const pkt = makePacket(service, endpoint, payload, seq, playerId || '');
    ws.send(pkt, { binary: true });
    console.log(`[>] ${service}/${endpoint} seq=${seq} payload=${payload ? payload.length : 0}B`);
  };

  ws.on('message', (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!isBinary) { console.log(`[<] text: ${buf.toString().slice(0, 200)}`); return; }
    let p;
    try { p = parsePacket(buf); }
    catch (e) { console.log(`[!] unparsable (${buf.length}B): ${hex(buf)}`); return; }
    console.log(`[<] ${p.service}/${p.endpoint} seq=${p.sequenceId} user=${p.userId} payload=${p.payload.length}B hex=${hex(p.payload, 64)}`);

    if (MATCH_ROUTER_JOIN.test(p.endpoint)) {
      // RouterJoin: 0 Platform(i32), 1 BuildVersion, 2 DeviceID, 3 UserID
      try { const j = readRoot(p.payload); playerId = j.str(3) || p.userId || playerId; } catch (_) {}
      send(p.service, ROUTER_ACK_ENDPOINT, Buffer.alloc(0), p.sequenceId);
    } else if (MATCH_USER_GET.test(p.endpoint)) {
      // UserGet: 0 Name, 1 OS, 2 BuildVersion, 3 DeviceID, 4 IP, 5 AuthProviderID, 6 PlayerID, 7 AuthData, 8 CountryCode
      let name = 'Player', pid = '';
      try { const u = readRoot(p.payload); name = u.str(0) || name; pid = u.str(6); } catch (_) {}
      playerId = pid || playerId || p.userId || crypto.randomUUID();
      send(p.service, USERGET_RESP_ENDPOINT, makeUserGetResponse(playerId, name), p.sequenceId);
    } else {
      console.log('[?] unhandled endpoint - add a handler once the real name/format is known');
    }
  });

  ws.on('close', (c) => console.log(`[-] close code=${c}`));
  ws.on('error', (e) => console.log(`[!] ws error ${e.message}`));
});

// keep Render's proxy from idling the socket out
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 25000);

server.listen(PORT, () => console.log(`listening on ${PORT}`));

module.exports = { buildBuffer, readRoot, makePacket, parsePacket, makeUserGetResponse };
