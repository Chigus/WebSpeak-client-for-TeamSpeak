const MAX_IDENTITY_TEXT = 128 * 1024;
const P256_SIZE = 32;
const MAX_TEAM_SPEAK_OFFSET = 18_446_744_073_709_551_615n;
const TEAM_SPEAK_OBFUSCATION_KEY = "b9dfaa7bee6ac57ac7b65f1094a1c155e747327bc2fe5d51c512023fe54a280201004e90ad1daaae1075d53b7d571c30e063b5a62a4a017bb394833aa0983e6e";

export type IdentityImportErrorCode = "empty" | "too-large" | "multiple" | "malformed" | "invalid-key" | "unsupported";

export class IdentityImportError extends Error {
  constructor(readonly code: IdentityImportErrorCode) {
    super(code);
    this.name = "IdentityImportError";
  }
}

/** Parse a TeamSpeak 3 identity INI/value or a WebSpeak SDK identity string locally. */
export async function importIdentityText(input: string): Promise<string> {
  if (input.length > MAX_IDENTITY_TEXT) throw new IdentityImportError("too-large");
  const text = input.replace(/^\uFEFF/, "").trim();
  if (!text) throw new IdentityImportError("empty");

  const sdkMaterial = extractSdkMaterial(text);
  if (sdkMaterial) return normalizeSdkMaterial(sdkMaterial);

  const iniIdentity = extractTeamSpeakIdentity(text);
  if (!iniIdentity) throw new IdentityImportError("malformed");

  const separator = iniIdentity.indexOf("V");
  if (separator <= 0 || separator === iniIdentity.length - 1) throw new IdentityImportError("malformed");
  const offset = parseOffset(iniIdentity.slice(0, separator));
  const encoded = iniIdentity.slice(separator + 1).replace(/\s/g, "");

  try {
    const obfuscated = decodeBase64(encoded);
    if (obfuscated.length <= 20) throw new Error("short identity blob");

    // TeamSpeak applies the static XOR first and then masks the first 20 bytes
    // with SHA-1 of the remaining C-string. A zero byte inside that suffix is
    // therefore the same terminator the native client sees.
    const nul = obfuscated.indexOf(0, 20);
    const hashEnd = nul < 0 ? obfuscated.length : nul;
    const digest = new Uint8Array(await requireSubtleCrypto().digest("SHA-1", obfuscated.slice(20, hashEnd)));
    for (let i = 0; i < 20; i++) obfuscated[i] ^= digest[i]!;

    xorStaticKey(obfuscated);
    const derBase64 = bytesToAscii(obfuscated);
    const privateDer = decodeBase64(derBase64);
    const key = decodeTeamSpeakPrivateKey(privateDer);
    const derived = await deriveP256Key(key.privateScalar);
    if (!bytesEqual(key.x, derived.x) || !bytesEqual(key.y, derived.y)) throw new Error("keypair mismatch");

    return `${bytesToBase64(key.privateScalar)}:${offset}`;
  } catch (error) {
    if (error instanceof IdentityImportError) throw error;
    throw new IdentityImportError("invalid-key");
  }
}

/** Export a WebSpeak identity as a TeamSpeak-compatible .ini file, in-browser. */
export async function exportTeamSpeakIdentity(privateMaterial: string): Promise<string> {
  const normalized = await normalizeSdkMaterial(privateMaterial);
  const splitAt = normalized.lastIndexOf(":");
  const privateScalar = decodeBase64(normalized.slice(0, splitAt));
  const offset = normalized.slice(splitAt + 1);
  const key = await deriveP256Key(privateScalar);
  const privateDer = encodeSequence([
    encodeTlv(0x03, new Uint8Array([0x07, 0x80])), // LTC BIT STRING: PK_PRIVATE flag = 1 bit
    encodeInteger(new Uint8Array([P256_SIZE])),
    encodeInteger(key.x),
    encodeInteger(key.y),
    encodeInteger(privateScalar),
  ]);

  const obfuscated = new TextEncoder().encode(bytesToBase64(privateDer));
  xorStaticKey(obfuscated);
  const nul = obfuscated.indexOf(0, 20);
  const hashEnd = nul < 0 ? obfuscated.length : nul;
  const digest = new Uint8Array(await requireSubtleCrypto().digest("SHA-1", obfuscated.slice(20, hashEnd)));
  for (let i = 0; i < 20; i++) obfuscated[i] ^= digest[i]!;

  const identity = `${offset}V${bytesToBase64(obfuscated)}`;
  return `[Identity]\r\nid=WebSpeak\r\nidentity="${identity}"\r\nnickname=WebSpeak\r\nphonetic_nickname=\r\n`;
}

function extractSdkMaterial(text: string): string | null {
  const match = text.match(/^(?:identity\s*=\s*)?["']?([A-Za-z0-9+/_=-]{4,64}):(\d+)["']?$/i);
  return match ? `${match[1]}:${match[2]}` : null;
}

function extractTeamSpeakIdentity(text: string): string | null {
  const values: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*identity\s*=\s*(.*?)\s*(?:[;#].*)?$/i);
    if (match) values.push(match[1]!.trim().replace(/^(?:"(.*)"|'(.*)')$/, (_all, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted));
  }
  if (values.length > 1) throw new IdentityImportError("multiple");
  if (values.length === 1) return values[0]!;

  const rawValue = text.replace(/[\s"']/g, "");
  return /^\d+V[A-Za-z0-9+/=_-]+$/i.test(rawValue) ? rawValue : null;
}

function parseOffset(value: string): string {
  if (!/^\d{1,20}$/.test(value)) throw new IdentityImportError("malformed");
  const offset = BigInt(value);
  if (offset > MAX_TEAM_SPEAK_OFFSET) throw new IdentityImportError("malformed");
  return offset.toString(10);
}

async function normalizeSdkMaterial(value: string): Promise<string> {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) throw new IdentityImportError("malformed");
  const offset = parseOffset(value.slice(separator + 1));
  try {
    const encodedScalar = value.slice(0, separator).replace(/\s/g, "");
    const decoded = decodeBase64(encodedScalar);
    if (decoded.length === 0 || decoded.length > P256_SIZE) throw new Error("invalid scalar size");
    const scalar = new Uint8Array(P256_SIZE);
    scalar.set(decoded, P256_SIZE - decoded.length);
    await deriveP256Key(scalar);
    return `${bytesToBase64(scalar)}:${offset}`;
  } catch (error) {
    if (error instanceof IdentityImportError) throw error;
    throw new IdentityImportError("invalid-key");
  }
}

async function deriveP256Key(privateScalar: Uint8Array): Promise<{ privateScalar: Uint8Array; x: Uint8Array; y: Uint8Array }> {
  const subtle = requireSubtleCrypto();
  const sec1 = encodeSequence([
    encodeInteger(new Uint8Array([1])),
    encodeTlv(0x04, privateScalar),
    encodeTlv(0xa0, encodeTlv(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]))),
  ]);
  const algorithm = encodeSequence([
    encodeTlv(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01])),
    encodeTlv(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07])),
  ]);
  const pkcs8 = encodeSequence([
    encodeInteger(new Uint8Array([0])),
    algorithm,
    encodeTlv(0x04, sec1),
  ]);
  try {
    const imported = await subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const jwk = await subtle.exportKey("jwk", imported);
    if (!jwk.x || !jwk.y || !jwk.d) throw new Error("missing curve coordinates");
    return {
      privateScalar: base64UrlToBytes(jwk.d),
      x: base64UrlToBytes(jwk.x),
      y: base64UrlToBytes(jwk.y),
    };
  } catch {
    throw new Error("invalid P-256 private key");
  }
}

function decodeTeamSpeakPrivateKey(der: Uint8Array): { privateScalar: Uint8Array; x: Uint8Array; y: Uint8Array } {
  const sequence = readTlv(der, 0, 0x30);
  if (sequence.end !== der.length) throw new Error("trailing DER data");
  let offset = 0;
  const flags = readTlv(sequence.value, offset, 0x03);
  offset = flags.end;
  if (flags.value.length !== 2 || flags.value[0] !== 7 || (flags.value[1]! & 0x80) === 0) throw new Error("private key flag missing");

  const size = readTlv(sequence.value, offset, 0x02);
  offset = size.end;
  if (integerToNumber(size.value) !== P256_SIZE) throw new Error("unexpected curve size");
  const xTlv = readTlv(sequence.value, offset, 0x02);
  const x = normalizeInteger(xTlv.value, P256_SIZE);
  offset = xTlv.end;
  const yTlv = readTlv(sequence.value, offset, 0x02);
  const y = normalizeInteger(yTlv.value, P256_SIZE);
  offset = yTlv.end;
  const privateTlv = readTlv(sequence.value, offset, 0x02);
  const privateScalar = normalizeInteger(privateTlv.value, P256_SIZE);
  offset = privateTlv.end;
  if (offset !== sequence.value.length) throw new Error("unexpected DER fields");
  return { privateScalar, x, y };
}

function readTlv(data: Uint8Array, offset: number, tag: number): { value: Uint8Array; end: number } {
  if (data[offset] !== tag) throw new Error("unexpected DER tag");
  let cursor = offset + 1;
  const firstLength = data[cursor++];
  if (firstLength === undefined) throw new Error("truncated DER length");
  let length: number;
  if (firstLength < 0x80) length = firstLength;
  else {
    const lengthBytes = firstLength & 0x7f;
    if (lengthBytes < 1 || lengthBytes > 2 || cursor + lengthBytes > data.length) throw new Error("invalid DER length");
    length = 0;
    for (let i = 0; i < lengthBytes; i++) length = length * 256 + data[cursor++]!;
  }
  const end = cursor + length;
  if (end > data.length) throw new Error("truncated DER value");
  return { value: data.slice(cursor, end), end };
}

function integerToNumber(value: Uint8Array): number {
  const normalized = normalizeInteger(value, 4);
  return normalized.reduce((number, byte) => number * 256 + byte, 0);
}

function normalizeInteger(value: Uint8Array, size: number): Uint8Array {
  if (value.length === 0 || (value[0]! & 0x80) !== 0) throw new Error("negative or empty DER integer");
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const significant = value.slice(start);
  if (significant.length > size) throw new Error("DER integer too large");
  const normalized = new Uint8Array(size);
  normalized.set(significant, size - significant.length);
  return normalized;
}

function encodeInteger(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const significant = value.slice(start);
  const positive = (significant[0]! & 0x80) === 0 ? significant : concatBytes(new Uint8Array([0]), significant);
  return encodeTlv(0x02, positive);
}

function encodeSequence(values: Uint8Array[]): Uint8Array {
  return encodeTlv(0x30, concatBytes(...values));
}

function encodeTlv(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), encodeDerLength(value.length), value);
}

function encodeDerLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  if (length < 0x100) return new Uint8Array([0x81, length]);
  return new Uint8Array([0x82, length >>> 8, length & 0xff]);
}

function xorStaticKey(bytes: Uint8Array): void {
  const key = new TextEncoder().encode(TEAM_SPEAK_OBFUSCATION_KEY);
  for (let i = 0; i < Math.min(100, bytes.length); i++) bytes[i] ^= key[i]!;
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) throw new Error("invalid base64");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64UrlToBytes(value: string): Uint8Array {
  return decodeBase64(value.replace(/-/g, "+").replace(/_/g, "/"));
}

function bytesToAscii(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    if (byte > 0x7f) throw new Error("non-ASCII identity data");
    result += String.fromCharCode(byte);
  }
  return result;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function requireSubtleCrypto(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) throw new IdentityImportError("unsupported");
  return globalThis.crypto.subtle;
}
