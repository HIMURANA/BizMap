import { closeSync, openSync, readSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/**
 * Minimal streaming reader for the OpenStreetMap PBF format (https://wiki.openstreetmap.org/wiki/PBF_Format).
 * No dependencies. Decodes only what discovery needs: nodes (plain + dense), ways and relations with tags.
 *
 * Numbers are decoded as JS doubles (exact up to 2^53, far above any real OSM id or coordinate delta).
 * Blobs are read and inflated one at a time, so memory stays small regardless of file size.
 */

export type Tags = Record<string, string>;
export interface RelMember { type: 'node' | 'way' | 'relation'; ref: number; role: string }

export interface PbfHandlers {
  node?: (id: number, lat: number, lon: number, tags: Tags | null) => void;
  way?: (id: number, refs: number[], tags: Tags | null) => void;
  relation?: (id: number, members: RelMember[], tags: Tags | null) => void;
}

const utf8 = new TextDecoder('utf-8');
const MEMBER_TYPES = ['node', 'way', 'relation'] as const;

class Reader {
  pos: number;
  constructor(readonly buf: Uint8Array, start = 0, readonly end = buf.length) {
    this.pos = start;
  }
  get done(): boolean { return this.pos >= this.end; }
  varint(): number {
    let result = 0, mult = 1, b: number;
    do {
      b = this.buf[this.pos++]!;
      result += (b & 0x7f) * mult;
      mult *= 128;
    } while (b & 0x80);
    return result;
  }
  sint(): number {
    const n = this.varint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }
  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const len = this.varint(); // read first: `pos += varint()` would use the stale pos
      this.pos += len;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`Unsupported protobuf wire type ${wire}`);
  }
}

function packedUint(b: Uint8Array): number[] {
  const r = new Reader(b), out: number[] = [];
  while (!r.done) out.push(r.varint());
  return out;
}
function packedSint(b: Uint8Array): number[] {
  const r = new Reader(b), out: number[] = [];
  while (!r.done) out.push(r.sint());
  return out;
}
function deltaDecode(xs: number[]): number[] {
  let acc = 0;
  return xs.map((x) => (acc += x));
}

interface Block { strings: string[]; groups: Uint8Array[]; gran: number; latOff: number; lonOff: number }

function decodeBlock(buf: Uint8Array): Block {
  const r = new Reader(buf);
  const block: Block = { strings: [], groups: [], gran: 100, latOff: 0, lonOff: 0 };
  while (!r.done) {
    const t = r.varint(), field = t >>> 3, wire = t & 7;
    if (field === 1 && wire === 2) {
      const st = new Reader(r.bytes());
      while (!st.done) {
        const t2 = st.varint();
        if ((t2 >>> 3) === 1 && (t2 & 7) === 2) block.strings.push(utf8.decode(st.bytes()));
        else st.skip(t2 & 7);
      }
    } else if (field === 2 && wire === 2) block.groups.push(r.bytes());
    else if (field === 17 && wire === 0) block.gran = r.varint();
    else if (field === 19 && wire === 0) block.latOff = r.sint();
    else if (field === 20 && wire === 0) block.lonOff = r.sint();
    else r.skip(wire);
  }
  return block;
}

function tagsFrom(strings: string[], keys: number[], vals: number[]): Tags | null {
  if (keys.length === 0) return null;
  const t: Tags = {};
  for (let i = 0; i < keys.length; i++) t[strings[keys[i]!]!] = strings[vals[i]!]!;
  return t;
}

function decodeGroup(g: Uint8Array, b: Block, h: PbfHandlers): void {
  const r = new Reader(g);
  const scale = 1e-9;
  while (!r.done) {
    const t = r.varint(), field = t >>> 3, wire = t & 7;
    if (wire !== 2) { r.skip(wire); continue; }
    const body = r.bytes();

    if (field === 1 && h.node) { // plain Node
      const n = new Reader(body);
      let id = 0, lat = 0, lon = 0, keys: number[] = [], vals: number[] = [];
      while (!n.done) {
        const t2 = n.varint(), f2 = t2 >>> 3, w2 = t2 & 7;
        if (f2 === 1 && w2 === 0) id = n.sint() ; // Node.id is sint64
        else if (f2 === 2 && w2 === 2) keys = packedUint(n.bytes());
        else if (f2 === 3 && w2 === 2) vals = packedUint(n.bytes());
        else if (f2 === 8 && w2 === 0) lat = n.sint();
        else if (f2 === 9 && w2 === 0) lon = n.sint();
        else n.skip(w2);
      }
      h.node(id, (b.latOff + b.gran * lat) * scale, (b.lonOff + b.gran * lon) * scale, tagsFrom(b.strings, keys, vals));
    } else if (field === 2 && h.node) { // DenseNodes
      const d = new Reader(body);
      let ids: number[] = [], lats: number[] = [], lons: number[] = [], kv: number[] = [];
      while (!d.done) {
        const t2 = d.varint(), f2 = t2 >>> 3, w2 = t2 & 7;
        if (f2 === 1 && w2 === 2) ids = deltaDecode(packedSint(d.bytes()));
        else if (f2 === 8 && w2 === 2) lats = deltaDecode(packedSint(d.bytes()));
        else if (f2 === 9 && w2 === 2) lons = deltaDecode(packedSint(d.bytes()));
        else if (f2 === 10 && w2 === 2) kv = packedUint(d.bytes());
        else d.skip(w2);
      }
      let k = 0;
      for (let i = 0; i < ids.length; i++) {
        let tags: Tags | null = null;
        if (kv.length) {
          while (kv[k] !== 0 && k < kv.length) {
            tags ??= {};
            tags[b.strings[kv[k]!]!] = b.strings[kv[k + 1]!]!;
            k += 2;
          }
          k++; // the 0 delimiter
        }
        h.node(ids[i]!, (b.latOff + b.gran * lats[i]!) * scale, (b.lonOff + b.gran * lons[i]!) * scale, tags);
      }
    } else if (field === 3 && h.way) { // Way
      const w = new Reader(body);
      let id = 0, keys: number[] = [], vals: number[] = [], refs: number[] = [];
      while (!w.done) {
        const t2 = w.varint(), f2 = t2 >>> 3, w2 = t2 & 7;
        if (f2 === 1 && w2 === 0) id = w.varint();
        else if (f2 === 2 && w2 === 2) keys = packedUint(w.bytes());
        else if (f2 === 3 && w2 === 2) vals = packedUint(w.bytes());
        else if (f2 === 8 && w2 === 2) refs = deltaDecode(packedSint(w.bytes()));
        else w.skip(w2);
      }
      h.way(id, refs, tagsFrom(b.strings, keys, vals));
    } else if (field === 4 && h.relation) { // Relation
      const rr = new Reader(body);
      let id = 0, keys: number[] = [], vals: number[] = [], roles: number[] = [], mem: number[] = [], types: number[] = [];
      while (!rr.done) {
        const t2 = rr.varint(), f2 = t2 >>> 3, w2 = t2 & 7;
        if (f2 === 1 && w2 === 0) id = rr.varint();
        else if (f2 === 2 && w2 === 2) keys = packedUint(rr.bytes());
        else if (f2 === 3 && w2 === 2) vals = packedUint(rr.bytes());
        else if (f2 === 8 && w2 === 2) roles = packedUint(rr.bytes());
        else if (f2 === 9 && w2 === 2) mem = deltaDecode(packedSint(rr.bytes()));
        else if (f2 === 10 && w2 === 2) types = packedUint(rr.bytes());
        else rr.skip(w2);
      }
      const members: RelMember[] = mem.map((ref, i) => ({ type: MEMBER_TYPES[types[i] ?? 0] ?? 'node', ref, role: b.strings[roles[i] ?? 0] ?? '' }));
      h.relation(id, members, tagsFrom(b.strings, keys, vals));
    }
  }
}

/** One sequential pass over the file; only handlers that are provided are decoded. */
export function scanPbf(file: string, handlers: PbfHandlers): { blobs: number } {
  const fd = openSync(file, 'r');
  let pos = 0, blobs = 0;
  const readExact = (len: number): Buffer | null => {
    const buf = Buffer.allocUnsafe(len);
    const got = readSync(fd, buf, 0, len, pos);
    if (got === 0) return null;
    if (got !== len) throw new Error(`Truncated PBF: wanted ${len} bytes at ${pos}, got ${got}`);
    pos += len;
    return buf;
  };
  try {
    for (;;) {
      const lenBuf = readExact(4);
      if (!lenBuf) break;
      const headerLen = lenBuf.readUInt32BE(0);
      if (headerLen > 64 * 1024) throw new Error(`Implausible BlobHeader length ${headerLen}: not a PBF file?`);
      const header = new Reader(readExact(headerLen)!);
      let type = '', dataSize = 0;
      while (!header.done) {
        const t = header.varint(), f = t >>> 3, w = t & 7;
        if (f === 1 && w === 2) type = utf8.decode(header.bytes());
        else if (f === 3 && w === 0) dataSize = header.varint();
        else header.skip(w);
      }
      if (dataSize > 32 * 1024 * 1024) throw new Error(`Blob too large (${dataSize}) - corrupt file?`);
      const blob = new Reader(readExact(dataSize)!);
      if (type !== 'OSMData') continue;
      let raw: Uint8Array | null = null, zlibData: Uint8Array | null = null;
      while (!blob.done) {
        const t = blob.varint(), f = t >>> 3, w = t & 7;
        if (f === 1 && w === 2) raw = blob.bytes();
        else if (f === 3 && w === 2) zlibData = blob.bytes();
        else blob.skip(w);
      }
      const data = raw ?? (zlibData ? inflateSync(zlibData) : null);
      if (!data) throw new Error('Unsupported blob compression (only raw and zlib are handled)');
      const block = decodeBlock(data);
      for (const g of block.groups) decodeGroup(g, block, handlers);
      blobs++;
    }
  } finally {
    closeSync(fd);
  }
  return { blobs };
}
