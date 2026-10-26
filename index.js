// Traitor: Zombie Amongst Us (v0.12.04) - private server (Render): WebSocket router + matchmaker.
// The real-time game runs in udp-server.js (Termux / any UDP host); this service only issues connect tokens.
// Wire format: every WS binary message is a FlatBuffers Packets.Packet { 0 Service, 1 Endpoint, 2 Payload, 3 SequenceID, 4 UserID ... }
//   services: r = router, u = user service, mm = matchmaker, f = friends
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { readRoot, buildBuffer, F, W } = require('./fb');
const { createConnectToken } = require('./netcode');

const PORT = process.env.PORT || 3000;
const UDP_HOST = process.env.UDP_HOST || '127.0.0.1'; // where the game finds the UDP server (127.0.0.1 = same phone)
const UDP_PORT = Number(process.env.UDP_PORT || 40000);
const HB_MS = Number(process.env.HB_MS || 5000);

const hex = (b, n = 64) => Buffer.from(b).subarray(0, n).toString('hex') + (b.length > n ? '...' : '');

function makePacket(service, endpoint, payload, seq, userId) {
  return buildBuffer([F.str(service), F.str(endpoint), F.bytes(payload || Buffer.alloc(0)), F.i32(seq), userId ? F.str(userId) : null]);
}
function parsePacket(buf) {
  const t = readRoot(buf);
  return { service: t.str(0), endpoint: t.str(1), payload: t.bytes(2), seq: t.i32(3), userId: t.str(4) };
}

// UserGetResponse: 0 ID 1 Name 2 GameCode 3 HasUpdate 4 UpdateMsg 5 ClientSettings 6 NewUser 7 ReferralLevelClaims 8 ServerTime 9 ADCohorts
function userGetResponse(id, name) {
  return buildBuffer([F.str(id), F.str(name || 'Player'), F.str(crypto.randomBytes(3).toString('hex').toUpperCase()), null, F.str(''),
    F.table([null, null]), null, null, F.u64(Date.now()), null]);
}
// NewGameResponse: 0 ConnectToken 1 ServerTime 2 RoomID 3 GameMode
function newGameResponse(sess, ng) {
  const roomId = crypto.randomBytes(3).toString('hex').toUpperCase();
  const ud = JSON.stringify({ r: roomId, m: ng.mode, u: sess.playerId, n: sess.name, p: ng.priv ? 1 : 0, t: ng.traitors });
  const token = createConnectToken({
    clientId: BigInt('0x' + crypto.randomBytes(7).toString('hex')),
    servers: [{ ip: UDP_HOST, port: UDP_PORT }], timeoutSec: 15, expirySec: 300, userData: Buffer.from(ud),
  });
  console.log(`[mm] new game room=${roomId} mode=${ng.mode} traitors=${ng.traitors} private=${ng.priv} -> udp ${UDP_HOST}:${UDP_PORT}`);
  return buildBuffer([F.bytes(token), F.u64(Date.now()), F.str(roomId), F.i32(ng.mode)]);
}

// ---------------------------------------------------------------- http
const DOWNLOADS = new Set(['udp-server.js', 'netcode.js', 'fb.js']);
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/log') {
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
    req.on('end', () => { try { for (const l of JSON.parse(body).lines || []) console.log('[udp] ' + String(l).slice(0, 600)); } catch (e) {} res.writeHead(200); res.end('ok'); });
    return;
  }
  const m = req.url.match(/^\/dl\/([\w.-]+)$/);
  if (m && DOWNLOADS.has(m[1])) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(fs.readFileSync(path.join(__dirname, m[1]))); }
  res.writeHead(200); res.end('traitor server ok\n');
});
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  const sess = { playerId: '', name: 'Player' }; let hb = null; const t0 = Date.now();
  console.log(`[+] connect ip=${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
  const send = (service, endpoint, payload, seq) => {
    ws.send(makePacket(service, endpoint, payload, seq, sess.playerId), { binary: true });
    if (endpoint !== 'HB') console.log(`[>] ${service}/${endpoint} seq=${seq} payload=${payload ? payload.length : 0}B`);
  };
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let p; try { p = parsePacket(buf); } catch (e) { console.log(`[!] unparsable ${hex(buf)}`); return; }
    if (p.endpoint !== 'HBA') console.log(`[<] ${p.service}/${p.endpoint} seq=${p.seq} payload=${p.payload.length}B ${hex(p.payload)}`);
    const key = p.service + '/' + p.endpoint;
    if (key === 'r/JO') {
      try { const j = readRoot(p.payload); sess.playerId = j.str(3) || sess.playerId; } catch (e) {}
      send(p.service, 'JA', Buffer.alloc(0), p.seq);
      if (!hb && HB_MS > 0) hb = setInterval(() => { if (ws.readyState === 1) send('r', 'HB', Buffer.alloc(0), 0); }, HB_MS);
    } else if (key === 'u/UG') {
      let name = 'Player', pid = '';
      try { const u = readRoot(p.payload); name = u.str(0) || name; pid = u.str(6); } catch (e) {}
      sess.playerId = pid || sess.playerId || crypto.randomUUID(); sess.name = name;
      send(p.service, 'UG', userGetResponse(sess.playerId, name), p.seq);
    } else if (key === 'mm/NG') {
      const t = readRoot(p.payload);
      send(p.service, 'NG', newGameResponse(sess, { traitors: t.i32(0), priv: t.bool(1), lang: t.i32(2), mode: t.i32(3) }), p.seq);
    } else if (key === 'f/G') {
      send(p.service, 'G', buildBuffer([null, F.bytes(), F.bytes(), null]), p.seq); // no friends
    } else if (p.endpoint !== 'HBA') {
      console.log('[?] unhandled ' + key);
    }
  });
  ws.on('close', (c) => { if (hb) clearInterval(hb); console.log(`[-] close code=${c} after=${Date.now() - t0}ms`); });
  ws.on('error', (e) => console.log(`[!] ws error ${e.message}`));
});
setInterval(() => wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 25000);
server.listen(PORT, () => console.log(`listening on ${PORT} (udp target ${UDP_HOST}:${UDP_PORT})`));
