'use strict';
// Minimal FlatBuffers reader/writer (no dependencies).
// Slots follow the generated Create*/Add* order in the game's dump.cs.

// ---------------------------------------------------------------- reader
function readTable(buf, pos) {
  const vt = pos - buf.readInt32LE(pos);
  const vtSize = buf.readUInt16LE(vt);
  const field = (slot) => {
    const o = 4 + slot * 2;
    if (o >= vtSize) return 0;
    const rel = buf.readUInt16LE(vt + o);
    return rel ? pos + rel : 0;
  };
  const self = {
    has: (slot) => field(slot) !== 0,
    str(slot) {
      const f = field(slot); if (!f) return '';
      const p = f + buf.readUInt32LE(f);
      return buf.toString('utf8', p + 4, p + 4 + buf.readUInt32LE(p));
    },
    bytes(slot) {
      const f = field(slot); if (!f) return Buffer.alloc(0);
      const p = f + buf.readUInt32LE(f);
      return buf.subarray(p + 4, p + 4 + buf.readUInt32LE(p));
    },
    bool: (slot) => { const f = field(slot); return f ? buf.readUInt8(f) !== 0 : false; },
    u8: (slot, d = 0) => { const f = field(slot); return f ? buf.readUInt8(f) : d; },
    i8: (slot, d = 0) => { const f = field(slot); return f ? buf.readInt8(f) : d; },
    u16: (slot, d = 0) => { const f = field(slot); return f ? buf.readUInt16LE(f) : d; },
    i16: (slot, d = 0) => { const f = field(slot); return f ? buf.readInt16LE(f) : d; },
    u32: (slot, d = 0) => { const f = field(slot); return f ? buf.readUInt32LE(f) : d; },
    i32: (slot, d = 0) => { const f = field(slot); return f ? buf.readInt32LE(f) : d; },
    u64: (slot) => { const f = field(slot); return f ? buf.readBigUInt64LE(f) : 0n; },
    f32: (slot) => { const f = field(slot); return f ? buf.readFloatLE(f) : 0; },
    f64: (slot) => { const f = field(slot); return f ? buf.readDoubleLE(f) : 0; },
    table(slot) {
      const f = field(slot); if (!f) return null;
      return readTable(buf, f + buf.readUInt32LE(f));
    },
    tvec(slot) {
      const f = field(slot); if (!f) return [];
      const p = f + buf.readUInt32LE(f);
      const n = buf.readUInt32LE(p), out = [];
      for (let i = 0; i < n; i++) { const e = p + 4 + i * 4; out.push(readTable(buf, e + buf.readUInt32LE(e))); }
      return out;
    },
  };
  return self;
}
const readRoot = (buf) => readTable(buf, buf.readUInt32LE(0));

// ---------------------------------------------------------------- writer (forward-built)
// fields: array indexed by slot; entry = null | {t, v}
// t: bool u8 i8 u16 i16 u32 i32 u64 i64 f32 f64 | str bytes table tvec
//   table: v = fields array;  tvec: v = array of fields arrays
const SIZE = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, f32: 4, f64: 8, str: 4, bytes: 4, table: 4, tvec: 4 };

function buildBuffer(rootFields) {
  const chunks = [Buffer.alloc(8)]; let len = 8;
  const push = (b) => { chunks.push(b); len += b.length; };
  const align = (n) => { const pad = (n - (len % n)) % n; if (pad) push(Buffer.alloc(pad)); };
  const patches = [];

  const writeString = (s) => {
    align(4); const data = Buffer.from(s, 'utf8'); const pos = len;
    const b = Buffer.alloc(4); b.writeUInt32LE(data.length); push(b); push(data); push(Buffer.alloc(1)); return pos;
  };
  const writeBytes = (data) => {
    align(4); const pos = len; const b = Buffer.alloc(4); b.writeUInt32LE(data.length); push(b); push(Buffer.from(data)); return pos;
  };
  const writeTVec = (items) => {
    align(4); const pos = len;
    const b = Buffer.alloc(4 + items.length * 4); b.writeUInt32LE(items.length); push(b);
    items.forEach((fields, i) => { const t = writeTable(fields); patches.push({ at: pos + 4 + i * 4, target: t }); });
    return pos;
  };
  function writeTable(fields) {
    let off = 4, maxAlign = 4; const rel = [];
    fields.forEach((f, slot) => {
      if (!f) { rel[slot] = 0; return; }
      const sz = SIZE[f.t]; if (!sz) throw new Error('bad type ' + f.t);
      if (sz > maxAlign) maxAlign = sz;
      off = Math.ceil(off / sz) * sz; rel[slot] = off; off += sz;
    });
    const tableSize = off;
    align(2); const vtPos = len;
    const vt = Buffer.alloc(4 + rel.length * 2);
    vt.writeUInt16LE(vt.length, 0); vt.writeUInt16LE(tableSize, 2);
    rel.forEach((r, i) => vt.writeUInt16LE(r || 0, 4 + i * 2));
    push(vt); align(maxAlign);
    const tPos = len; const tb = Buffer.alloc(tableSize); tb.writeInt32LE(tPos - vtPos, 0);
    const children = [];
    fields.forEach((f, slot) => {
      if (!f) return; const o = rel[slot];
      switch (f.t) {
        case 'bool': tb.writeUInt8(f.v ? 1 : 0, o); break;
        case 'u8': tb.writeUInt8(f.v, o); break;
        case 'i8': tb.writeInt8(f.v, o); break;
        case 'u16': tb.writeUInt16LE(f.v, o); break;
        case 'i16': tb.writeInt16LE(f.v, o); break;
        case 'u32': tb.writeUInt32LE(f.v, o); break;
        case 'i32': tb.writeInt32LE(f.v, o); break;
        case 'u64': tb.writeBigUInt64LE(BigInt(f.v), o); break;
        case 'i64': tb.writeBigInt64LE(BigInt(f.v), o); break;
        case 'f32': tb.writeFloatLE(f.v, o); break;
        case 'f64': tb.writeDoubleLE(f.v, o); break;
        default: children.push({ at: tPos + o, f });
      }
    });
    push(tb);
    for (const c of children) {
      let target;
      if (c.f.t === 'str') target = writeString(c.f.v);
      else if (c.f.t === 'bytes') target = writeBytes(c.f.v);
      else if (c.f.t === 'tvec') target = writeTVec(c.f.v);
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

// field constructors
const F = {
  bool: (v) => (v ? { t: 'bool', v: true } : null),
  i8: (v) => (v ? { t: 'i8', v } : null), u8: (v) => (v ? { t: 'u8', v } : null), i32: (v) => (v ? { t: 'i32', v } : null),
  u16: (v) => (v ? { t: 'u16', v } : null), u32: (v) => (v ? { t: 'u32', v } : null),
  u64: (v) => (v ? { t: 'u64', v } : null), f32: (v) => (v ? { t: 'f32', v } : null), f64: (v) => (v ? { t: 'f64', v } : null),
  str: (v) => ({ t: 'str', v: v || '' }), bytes: (v) => ({ t: 'bytes', v: v || Buffer.alloc(0) }),
  table: (v) => ({ t: 'table', v }), tvec: (v) => ({ t: 'tvec', v: v || [] }),
};
// always-written scalar (even when zero) for fields where an explicit value matters
const W = { i8: (v) => ({ t: 'i8', v }), u8: (v) => ({ t: 'u8', v }), bool: (v) => ({ t: 'bool', v: !!v }), i32: (v) => ({ t: 'i32', v }), u16: (v) => ({ t: 'u16', v }) };

module.exports = { readTable, readRoot, buildBuffer, F, W };
