import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { kalshiAuthHeaders } from '../../lib/kalshi-auth';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs8Pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const pkcs1Pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;

function verify(message: string, signatureB64: string): boolean {
  const verifier = createVerify('sha256').update(message, 'utf8');
  return verifier.verify(
    { key: publicKey, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 },
    Buffer.from(signatureB64, 'base64'),
  );
}

describe('kalshiAuthHeaders', () => {
  it('produces a valid RSA-PSS signature over timestamp+method+path (PKCS#8 key)', async () => {
    const ts = 1753468800000;
    const headers = await kalshiAuthHeaders(
      { keyId: 'key-uuid', privateKeyPem: pkcs8Pem },
      'GET',
      '/trade-api/v2/markets',
      ts,
    );
    expect(headers['KALSHI-ACCESS-KEY']).toBe('key-uuid');
    expect(headers['KALSHI-ACCESS-TIMESTAMP']).toBe(String(ts));
    expect(verify(`${ts}GET/trade-api/v2/markets`, headers['KALSHI-ACCESS-SIGNATURE']!)).toBe(true);
  });

  it('accepts a PKCS#1 "RSA PRIVATE KEY" PEM (the Kalshi download format)', async () => {
    const ts = 1753468800000;
    const headers = await kalshiAuthHeaders(
      { keyId: 'key-uuid', privateKeyPem: pkcs1Pem },
      'GET',
      '/trade-api/v2/markets',
      ts,
    );
    expect(verify(`${ts}GET/trade-api/v2/markets`, headers['KALSHI-ACCESS-SIGNATURE']!)).toBe(true);
  });

  it('accepts a PEM with literal \\n escapes (dashboard secret paste)', async () => {
    const escaped = pkcs8Pem.replace(/\n/g, '\\n');
    const headers = await kalshiAuthHeaders(
      { keyId: 'key-uuid', privateKeyPem: escaped },
      'GET',
      '/trade-api/v2/markets',
      1753468800000,
    );
    expect(headers['KALSHI-ACCESS-SIGNATURE']).toBeTruthy();
  });
});
