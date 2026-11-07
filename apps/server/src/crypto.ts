import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export async function passwordKey(password: string, salt: Buffer): Promise<Buffer> {
  return await derive(password, salt, 32) as Buffer;
}
export function encrypt(data: Buffer, key: Buffer, context: string): Buffer {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const content = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), content]);
}
export function decrypt(data: Buffer, key: Buffer, context: string): Buffer {
  if (data.length < 28) throw new Error('Invalid encrypted envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
}
