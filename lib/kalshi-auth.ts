// Kalshi API request signing (optional, but strongly recommended in
// production): anonymous requests are rate-limited per IP, and Cloudflare
// Workers egress IPs are shared across many tenants, so the anonymous quota
// is usually exhausted (429) before our request ever lands. Authenticated
// requests are limited per API key instead.
//
// Scheme (docs.kalshi.com): sign `{timestamp_ms}{METHOD}{path-without-query}`
// with RSA-PSS SHA-256 (MGF1-SHA256, salt length = digest length), base64 it,
// and send KALSHI-ACCESS-KEY / KALSHI-ACCESS-TIMESTAMP / KALSHI-ACCESS-SIGNATURE.

export interface KalshiAuth {
  /** API Key ID (UUID) from the Kalshi dashboard. */
  keyId: string;
  /** RSA private key PEM (PKCS#8 "PRIVATE KEY" or PKCS#1 "RSA PRIVATE KEY"). */
  privateKeyPem: string;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** DER length prefix for a given content length. */
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/**
 * Wrap a PKCS#1 RSAPrivateKey DER in a PKCS#8 PrivateKeyInfo structure
 * (WebCrypto only imports PKCS#8). Deterministic ASN.1 assembly:
 * SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING }.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = [0x02, 0x01, 0x00];
  const algorithm = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const octetString = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const contentLength = version.length + algorithm.length + octetString.length;
  return new Uint8Array([
    0x30,
    ...derLength(contentLength),
    ...version,
    ...algorithm,
    ...octetString,
  ]);
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Dashboard secrets sometimes arrive with literal "\n" escapes.
  const normalized = pem.replace(/\\n/g, '\n').trim();
  const isPkcs1 = normalized.includes('RSA PRIVATE KEY');
  const base64 = normalized
    .replace(/-----(BEGIN|END) (RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const der = base64ToBytes(base64);
  const pkcs8 = isPkcs1 ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8.buffer as ArrayBuffer,
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** Signed auth headers for one request. `path` excludes the query string. */
export async function kalshiAuthHeaders(
  auth: KalshiAuth,
  method: string,
  path: string,
  timestampMs = Date.now(),
): Promise<Record<string, string>> {
  let keyPromise = keyCache.get(auth.privateKeyPem);
  if (!keyPromise) {
    keyPromise = importPrivateKey(auth.privateKeyPem);
    keyCache.set(auth.privateKeyPem, keyPromise);
  }
  const key = await keyPromise;
  const message = new TextEncoder().encode(`${timestampMs}${method.toUpperCase()}${path}`);
  const signature = await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, key, message);
  return {
    'KALSHI-ACCESS-KEY': auth.keyId,
    'KALSHI-ACCESS-TIMESTAMP': String(timestampMs),
    'KALSHI-ACCESS-SIGNATURE': bytesToBase64(new Uint8Array(signature)),
  };
}
