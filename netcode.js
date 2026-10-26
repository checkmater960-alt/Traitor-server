'use strict';
// netcode.io 1.01 (as used by NetcodeIO.NET): connect-token creation + dedicated UDP server. No dependencies.
const crypto = require('crypto');
const dgram = require('dgram');
const { EventEmitter } = require('events');

// Shared secrets: the matchmaker (Render) creates tokens, the UDP server (Termux) opens them.
const PROTOCOL_ID = 0x54524149544f5201n;
const PRIVATE_KEY = Buffer.from('7f3c1a9be2d4486a95c0b1e7d3a2f45860c9e1b7a4d23f5c8e6b0a1d9c7f2e34', 'hex');
const VERSION = Buffer.from('NETCODE 1.01\0', 'latin1'); // 13 bytes

const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

// ---- crypto
function aeadEncrypt(key, nonce12, aad, plain) {
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce12, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: plain.length });
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}
function aeadDecrypt(key, nonce12, aad, data) {
  if (data.length < 16) return null;
  try {
    const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce12, { authTagLength: 16 });
    d.setAAD(aad, { plaintextLength: data.length - 16 });
    d.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  } catch (e) { return null; }
}
const rotl = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;
function hchacha20(key, nonce16) {
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = nonce16.readUInt32LE(i * 4);
  const qr = (a, b, c, d) => {
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  [0, 1, 2, 3, 12, 13, 14, 15].forEach((w, i) => out.writeUInt32LE(s[w], i * 4));
  return out;
}
const xnonce = (n24) => Buffer.concat([Buffer.alloc(4), n24.subarray(16, 24)]);
const xchachaEncrypt = (key, n24, aad, p) => aeadEncrypt(hchacha20(key, n24.subarray(0, 16)), xnonce(n24), aad, p);
const xchachaDecrypt = (key, n24, aad, p) => aeadDecrypt(hchacha20(key, n24.subarray(0, 16)), xnonce(n24), aad, p);

// ---- addresses
function writeAddr(servers) {
  const parts = [];
  for (const s of servers) {
    const ip = s.ip.split('.').map(Number); const b = Buffer.alloc(7);
    b[0] = 1; b[1] = ip[0]; b[2] = ip[1]; b[3] = ip[2]; b[4] = ip[3]; b.writeUInt16LE(s.port, 5); parts.push(b);
  }
  return Buffer.concat(parts);
}

// ---- connect token (public part is 2048 bytes)
function createConnectToken({ clientId, servers, timeoutSec = 15, expirySec = 300, userData = Buffer.alloc(0), protocolId = PROTOCOL_ID, privateKey = PRIVATE_KEY }) {
  const now = BigInt(Math.floor(Date.now() / 1000)); const expire = now + BigInt(expirySec);
  const c2s = crypto.randomBytes(32), s2c = crypto.randomBytes(32);
  const priv = Buffer.alloc(1008); let o = 0;
  priv.writeBigUInt64LE(BigInt(clientId), o); o += 8;
  priv.writeUInt32LE(timeoutSec, o); o += 4;
  priv.writeUInt32LE(servers.length, o); o += 4;
  const addr = writeAddr(servers); addr.copy(priv, o); o += addr.length;
  c2s.copy(priv, o); o += 32; s2c.copy(priv, o); o += 32;
  Buffer.from(userData).subarray(0, 256).copy(priv, o);
  const seqBuf = crypto.randomBytes(8); const tokenSeq = seqBuf.readBigUInt64LE(0);
  const aad = Buffer.concat([VERSION, u64le(protocolId), u64le(expire)]);
  const encPriv = aeadEncrypt(privateKey, pktNonce(tokenSeq), aad, priv); // 1024 bytes
  const head = Buffer.alloc(13 + 8 + 8 + 8 + 8);
  VERSION.copy(head, 0); head.writeBigUInt64LE(BigInt(protocolId), 13); head.writeBigUInt64LE(now, 21); head.writeBigUInt64LE(expire, 29); head.writeBigUInt64LE(tokenSeq, 37);
  const tail = Buffer.alloc(8); tail.writeUInt32LE(timeoutSec, 0); tail.writeUInt32LE(servers.length, 4);
  const tok = Buffer.concat([head, encPriv, tail, addr, c2s, s2c]);
  return Buffer.concat([tok, Buffer.alloc(2048 - tok.length)]);
}

// ---- packets
const T = { REQUEST: 0, DENIED: 1, CHALLENGE: 2, RESPONSE: 3, KEEPALIVE: 4, PAYLOAD: 5, DISCONNECT: 6 };
function seqBytes(seq) { let n = 1; let v = BigInt(seq) >> 8n; while (v > 0n) { n++; v >>= 8n; } return n; }
function packetAad(prefix, protocolId) { return Buffer.concat([VERSION, u64le(protocolId), Buffer.from([prefix])]); }
const pktNonce = (seq) => Buffer.concat([Buffer.alloc(4), u64le(seq)]);
function encodePacket(type, key, seq, payload, protocolId = PROTOCOL_ID) {
  const n = seqBytes(seq); const prefix = (n << 4) | type;
  const sb = u64le(seq).subarray(0, n);
  return Buffer.concat([Buffer.from([prefix]), sb, aeadEncrypt(key, pktNonce(seq), packetAad(prefix, protocolId), payload)]);
}
function decodePacket(buf, key, protocolId = PROTOCOL_ID) {
  const prefix = buf[0]; const type = prefix & 0xf; const n = prefix >> 4;
  if (n < 1 || n > 8 || buf.length < 1 + n + 16) return null;
  const sb = Buffer.alloc(8); buf.copy(sb, 0, 1, 1 + n); const seq = sb.readBigUInt64LE(0);
  const payload = aeadDecrypt(key, pktNonce(seq), packetAad(prefix, protocolId), buf.subarray(1 + n));
  return payload ? { type, seq, payload } : null;
}

// ---- server
class NetcodeServer extends EventEmitter {
  constructor({ port, maxClients = 16, protocolId = PROTOCOL_ID, privateKey = PRIVATE_KEY, log = () => {} }) {
    super(); Object.assign(this, { port, maxClients, protocolId, privateKey, log });
    this.challengeKey = crypto.randomBytes(32); this.challengeSeq = 0n;
    this.pending = new Map(); this.clients = new Map(); this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m, r) => { try { this.onPacket(m, r); } catch (e) { this.log('netcode error ' + e.stack); } });
    this.sock.on('error', (e) => this.log('socket error ' + e.message));
  }
  start() {
    this.sock.bind(this.port, '0.0.0.0', () => this.log('netcode server listening udp ' + this.port));
    this.timer = setInterval(() => this.tick(), 1000);
  }
  tick() {
    const now = Date.now();
    for (const [k, c] of this.clients) {
      if (now - c.lastRecv > c.timeoutSec * 1000) { this.log('client timeout ' + k); this.drop(k, true); continue; }
      this.sendKeepAlive(c);
    }
    for (const [k, p] of this.pending) if (now - p.created > 10000) this.pending.delete(k);
  }
  raw(c, type, payload) {
    const pkt = encodePacket(type, c.s2c, c.sendSeq++, payload, this.protocolId);
    this.sock.send(pkt, c.port, c.address);
  }
  sendKeepAlive(c) { const b = Buffer.alloc(8); b.writeInt32LE(c.index, 0); b.writeInt32LE(this.maxClients, 4); this.raw(c, T.KEEPALIVE, b); }
  send(c, data) { this.raw(c, T.PAYLOAD, data); }
  drop(key, notify) {
    const c = this.clients.get(key); if (!c) return;
    if (notify) { for (let i = 0; i < 3; i++) this.raw(c, T.DISCONNECT, Buffer.alloc(0)); }
    this.clients.delete(key); this.emit('disconnect', c);
  }
  onPacket(msg, rinfo) {
    const key = rinfo.address + ':' + rinfo.port;
    if (msg.length === 0) return;
    const type = msg[0] & 0xf;
    if (type === T.REQUEST) return this.onRequest(msg, rinfo, key);
    const known = this.clients.get(key); const pend = this.pending.get(key);
    const rk = known ? known.c2s : pend ? pend.c2s : null;
    if (!rk) { this.log(`packet type ${type} from unknown ${key} (${msg.length}B)`); return; }
    const p = decodePacket(msg, rk, this.protocolId);
    if (!p) { this.log(`undecryptable packet type ${type} from ${key} (${msg.length}B)`); return; }
    if (type === T.RESPONSE && pend) return this.onResponse(p, rinfo, key, pend);
    if (!known) return;
    known.lastRecv = Date.now();
    if (type === T.PAYLOAD) this.emit('data', known, p.payload);
    else if (type === T.DISCONNECT) { this.log('client disconnect ' + key); this.drop(key, false); }
    else if (type === T.RESPONSE) this.sendKeepAlive(known);
  }
  onRequest(msg, rinfo, key) {
    if (msg.length !== 1062) { this.log(`bad request size ${msg.length} from ${key}`); return; }
    if (!msg.subarray(1, 14).equals(VERSION)) { this.log('bad version info: ' + msg.subarray(1, 14).toString('latin1')); return; }
    const protocolId = msg.readBigUInt64LE(14); const expire = msg.readBigUInt64LE(22); const tokenSeq = msg.readBigUInt64LE(30);
    if (protocolId !== this.protocolId) { this.log('bad protocol id ' + protocolId.toString(16)); return; }
    const enc = msg.subarray(38, 1062);
    const priv = aeadDecrypt(this.privateKey, pktNonce(tokenSeq), Buffer.concat([VERSION, u64le(protocolId), u64le(expire)]), enc);
    if (!priv) { this.log('connect token private data failed to decrypt'); return; }
    let o = 0; const clientId = priv.readBigUInt64LE(o); o += 8; const timeoutSec = priv.readUInt32LE(o); o += 4;
    const n = priv.readUInt32LE(o); o += 4; o += n * 7;
    const c2s = Buffer.from(priv.subarray(o, o + 32)); o += 32; const s2c = Buffer.from(priv.subarray(o, o + 32)); o += 32;
    const userData = Buffer.from(priv.subarray(o, o + 256));
    let p = this.pending.get(key);
    if (!p) { p = { c2s, s2c, clientId, timeoutSec, userData, sendSeq: 0n, created: Date.now(), address: rinfo.address, port: rinfo.port }; this.pending.set(key, p); this.log(`connection request from ${key} clientId=${clientId}`); }
    // challenge
    const cs = this.challengeSeq++;
    const plain = Buffer.alloc(284); plain.writeBigUInt64LE(clientId, 0); userData.copy(plain, 8);
    const ch = aeadEncrypt(this.challengeKey, pktNonce(cs), Buffer.alloc(0), plain); // 300 bytes
    const payload = Buffer.concat([u64le(cs), ch]);
    this.sock.send(encodePacket(T.CHALLENGE, p.s2c, p.sendSeq++, payload, this.protocolId), rinfo.port, rinfo.address);
  }
  onResponse(p, rinfo, key, pend) {
    if (p.payload.length !== 308) { this.log('bad response size ' + p.payload.length); return; }
    const cs = p.payload.readBigUInt64LE(0);
    const plain = aeadDecrypt(this.challengeKey, pktNonce(cs), Buffer.alloc(0), p.payload.subarray(8));
    if (!plain) { this.log('challenge token invalid'); return; }
    const clientId = plain.readBigUInt64LE(0);
    if (clientId !== pend.clientId) { this.log('challenge clientId mismatch'); return; }
    let index = 0; const used = new Set([...this.clients.values()].map((c) => c.index));
    while (used.has(index)) index++;
    if (index >= this.maxClients) { this.log('server full'); return; }
    this.pending.delete(key);
    const c = { key, index, clientId, userData: pend.userData, c2s: pend.c2s, s2c: pend.s2c, sendSeq: pend.sendSeq, timeoutSec: pend.timeoutSec, lastRecv: Date.now(), address: rinfo.address, port: rinfo.port };
    this.clients.set(key, c); this.log(`client connected ${key} index=${index} clientId=${clientId}`);
    this.sendKeepAlive(c); this.emit('connect', c);
  }
}

module.exports = { NetcodeServer, createConnectToken, PROTOCOL_ID, PRIVATE_KEY, VERSION, T, encodePacket, decodePacket, hchacha20, aeadEncrypt, aeadDecrypt, xchachaEncrypt, xchachaDecrypt, u64le };
