import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(buffer) {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let index = 0; index < bits.length; index += 5) {
    const chunk = bits.slice(index, index + 5).padEnd(5, "0");
    out += ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}

export function decodeBase32(value) {
  const clean = value.replace(/=+$/g, "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Secret de double authentification illisible");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

export function hotp(key, counter, digits = 6) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, "0");
}

export function totp(secret, at = Date.now(), digits = 6, step = 30) {
  const counter = Math.floor(at / 1000 / step);
  const key = Buffer.isBuffer(secret) ? secret : decodeBase32(secret);
  return hotp(key, counter, digits);
}

export function verifyTotp(secret, token, at = Date.now()) {
  const clean = String(token || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(at / 1000 / 30);
  const key = decodeBase32(secret);
  return [-1, 0, 1].some((shift) => hotp(key, counter + shift, 6) === clean);
}

export function newTotpSecret() {
  return encodeBase32(crypto.randomBytes(20));
}
