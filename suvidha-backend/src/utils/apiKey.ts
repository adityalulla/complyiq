import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// The raw key is shown to the user ONCE, when they connect an integration -
// only its hash is ever stored in the database, same principle as a password.
export function generateApiKey(): string {
  return 'sk_' + crypto.randomBytes(24).toString('hex');
}

export async function hashApiKey(rawKey: string): Promise<string> {
  return bcrypt.hash(rawKey, 10);
}

export async function verifyApiKey(rawKey: string, storedHash: string): Promise<boolean> {
  return bcrypt.compare(rawKey, storedHash);
}
