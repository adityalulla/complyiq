import crypto from 'crypto';

// AES-256-GCM: needs a 32-byte key. Generate one with `openssl rand -hex 32`
// and put it in TOKEN_ENCRYPTION_KEY - never reuse the JWT secrets for this.
const KEY = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || '', 'hex');

export function encryptToken(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store iv + authTag + ciphertext together, colon-separated, so decryption
  // has everything it needs from a single stored string.
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

export function decryptToken(stored: string): string {
  const [ivHex, authTagHex, encryptedHex] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
