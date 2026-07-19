/**
 * At-rest encryption for demo tester wallet secrets. AES-256-GCM with a
 * per-context key derived via HKDF from the app secret (ENCRYPTION_KEY),
 * same construction as the passport payload cipher in passport-anchor.ts.
 * Output: base64(iv(12) || authTag(16) || ciphertext).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

function contextKey(context: string): Buffer {
    const masterHex = process.env.ENCRYPTION_KEY;
    const master = masterHex
        ? Buffer.from(masterHex, 'hex')
        : Buffer.from('00'.repeat(32), 'hex'); // dev fallback; prod must set ENCRYPTION_KEY
    return Buffer.from(
        hkdfSync('sha256', master, Buffer.from(context, 'utf8'), Buffer.from('nightpass-demo-secret'), 32)
    );
}

export function encryptSecret(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', contextKey(context), iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(encoded: string, context: string): string {
    const buf = Buffer.from(encoded, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', contextKey(context), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
