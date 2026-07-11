/**
 * NIP-19 bech32 codecs (npub, naddr). Self-contained BIP-173 bech32
 * implementation — no external dependency; the only consumers are these
 * fixed-prefix codecs.
 */

export type AddressPointer = {
  identifier: string; // d tag
  pubkey: string;
  kind: number;
  relays?: string[];
};

// --- bech32 (BIP-173, checksum constant 1 — NIP-19 does not use bech32m) ---

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CHARSET_REV = new Map<string, number>(
  [...CHARSET].map((c, i) => [c, i]),
);
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
/** NIP-19 entities exceed BIP-173's 90-char cap; cap length like nostr-tools. */
const MAX_BECH32_LENGTH = 5000;

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GENERATOR[i]!;
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/**
 * Regroup bits. `pad` is true when encoding (8→5), false when decoding (5→8);
 * decoding rejects nonzero or over-long padding per BIP-173.
 */
function convertBits(
  data: ArrayLike<number>,
  fromBits: number,
  toBits: number,
  pad: boolean,
): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (let i = 0; i < data.length; i++) {
    const value = data[i]!;
    if (value < 0 || value >>> fromBits !== 0) {
      throw new Error("nip19: invalid value in bit conversion");
    }
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    throw new Error("nip19: invalid padding in bech32 data");
  }
  return out;
}

/** Encode raw bytes as a bech32 string under `hrp`. Low-level; prefer the NIP-19 codecs. */
export function bech32EncodeBytes(hrp: string, bytes: Uint8Array): string {
  const data = convertBits(bytes, 8, 5, true);
  const combined = [...hrpExpand(hrp), ...data];
  const polymodTarget = polymod([...combined, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((polymodTarget >>> (5 * (5 - i))) & 31);
  }
  const encoded = hrp + "1" + [...data, ...checksum].map((v) => CHARSET[v]).join("");
  if (encoded.length > MAX_BECH32_LENGTH) {
    throw new Error("nip19: encoded entity too long");
  }
  return encoded;
}

/** Decode a bech32 string to `{ hrp, bytes }`. Throws on any corruption. */
export function bech32DecodeBytes(str: string): {
  hrp: string;
  bytes: Uint8Array;
} {
  if (typeof str !== "string" || str.length < 8 || str.length > MAX_BECH32_LENGTH) {
    throw new Error("nip19: invalid bech32 length");
  }
  const lower = str.toLowerCase();
  if (str !== lower && str !== str.toUpperCase()) {
    throw new Error("nip19: mixed-case bech32 is invalid");
  }
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) {
    throw new Error("nip19: missing bech32 separator or checksum");
  }
  const hrp = lower.slice(0, sep);
  for (let i = 0; i < hrp.length; i++) {
    const code = hrp.charCodeAt(i);
    if (code < 33 || code > 126) throw new Error("nip19: invalid hrp character");
  }
  const data: number[] = [];
  for (const ch of lower.slice(sep + 1)) {
    const v = CHARSET_REV.get(ch);
    if (v === undefined) throw new Error("nip19: invalid bech32 character");
    data.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) {
    throw new Error("nip19: bad bech32 checksum");
  }
  const bytes = Uint8Array.from(convertBits(data.slice(0, -6), 5, 8, false));
  return { hrp, bytes };
}

// --- NIP-19 codecs ---

const HEX_64 = /^[0-9a-f]{64}$/;

function hexToBytes32(hex: string, what: string): Uint8Array {
  if (!HEX_64.test(hex)) {
    throw new Error(`nip19: ${what} must be 64 lowercase hex chars`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHexStr(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Encode a 32-byte hex pubkey as `npub1…`. */
export function npubEncode(pubkeyHex: string): string {
  return bech32EncodeBytes("npub", hexToBytes32(pubkeyHex, "pubkey"));
}

/** Decode an `npub1…` string to the 64-char hex pubkey. Throws on wrong prefix or corruption. */
export function npubDecode(npub: string): string {
  const { hrp, bytes } = bech32DecodeBytes(npub);
  if (hrp !== "npub") throw new Error(`nip19: expected npub, got ${hrp}`);
  if (bytes.length !== 32) throw new Error("nip19: npub payload must be 32 bytes");
  return bytesToHexStr(bytes);
}

// TLV types per NIP-19
const TLV_SPECIAL = 0;
const TLV_RELAY = 1;
const TLV_AUTHOR = 2;
const TLV_KIND = 3;

/**
 * Encode an address pointer as `naddr1…`. TLV entry order matches nostr-tools
 * (kind, author, relays, identifier) for byte-identical interop.
 */
export function naddrEncode(ptr: AddressPointer): string {
  const author = hexToBytes32(ptr.pubkey, "pubkey");
  if (!Number.isInteger(ptr.kind) || ptr.kind < 0 || ptr.kind > 0xffffffff) {
    throw new Error("nip19: kind must be an integer in [0, 2^32)");
  }
  if (typeof ptr.identifier !== "string") {
    throw new Error("nip19: identifier must be a string");
  }
  const identifier = new TextEncoder().encode(ptr.identifier);
  if (identifier.length > 255) {
    throw new Error("nip19: identifier too long for TLV (max 255 bytes)");
  }
  const parts: number[] = [];
  parts.push(TLV_KIND, 4);
  parts.push(
    (ptr.kind >>> 24) & 0xff,
    (ptr.kind >>> 16) & 0xff,
    (ptr.kind >>> 8) & 0xff,
    ptr.kind & 0xff,
  );
  parts.push(TLV_AUTHOR, 32, ...author);
  for (const relay of ptr.relays ?? []) {
    const relayBytes = new TextEncoder().encode(relay);
    if (relayBytes.length > 255) {
      throw new Error("nip19: relay url too long for TLV (max 255 bytes)");
    }
    parts.push(TLV_RELAY, relayBytes.length, ...relayBytes);
  }
  parts.push(TLV_SPECIAL, identifier.length, ...identifier);
  return bech32EncodeBytes("naddr", Uint8Array.from(parts));
}

/** Decode an `naddr1…` string to an address pointer. Throws on wrong prefix, corruption, or missing TLVs. */
export function naddrDecode(naddr: string): AddressPointer {
  const { hrp, bytes } = bech32DecodeBytes(naddr);
  if (hrp !== "naddr") throw new Error(`nip19: expected naddr, got ${hrp}`);
  let identifier: string | undefined;
  let pubkey: string | undefined;
  let kind: number | undefined;
  const relays: string[] = [];
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let i = 0;
  while (i < bytes.length) {
    if (i + 2 > bytes.length) throw new Error("nip19: truncated TLV header");
    const type = bytes[i]!;
    const length = bytes[i + 1]!;
    if (i + 2 + length > bytes.length) {
      throw new Error("nip19: truncated TLV value");
    }
    const value = bytes.subarray(i + 2, i + 2 + length);
    i += 2 + length;
    switch (type) {
      case TLV_SPECIAL:
        if (identifier !== undefined) {
          throw new Error("nip19: duplicate identifier TLV");
        }
        identifier = utf8.decode(value);
        break;
      case TLV_RELAY:
        relays.push(utf8.decode(value));
        break;
      case TLV_AUTHOR:
        if (pubkey !== undefined) throw new Error("nip19: duplicate author TLV");
        if (value.length !== 32) {
          throw new Error("nip19: author TLV must be 32 bytes");
        }
        pubkey = bytesToHexStr(value);
        break;
      case TLV_KIND:
        if (kind !== undefined) throw new Error("nip19: duplicate kind TLV");
        if (value.length !== 4) throw new Error("nip19: kind TLV must be 4 bytes");
        kind = (value[0]! << 24) | (value[1]! << 16) | (value[2]! << 8) | value[3]!;
        kind >>>= 0;
        break;
      default:
        // Per NIP-19, readers ignore unknown TLV types.
        break;
    }
  }
  if (identifier === undefined) throw new Error("nip19: naddr missing identifier TLV");
  if (pubkey === undefined) throw new Error("nip19: naddr missing author TLV");
  if (kind === undefined) throw new Error("nip19: naddr missing kind TLV");
  const ptr: AddressPointer = { identifier, pubkey, kind };
  if (relays.length > 0) ptr.relays = relays;
  return ptr;
}
