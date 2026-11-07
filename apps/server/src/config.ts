import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, statSync } from 'node:fs';
export interface AppConfig { dataDir: string; host: string; port: number; origin: string; remote: boolean; accessPassword?: string; tls?: { key: Buffer; cert: Buffer }; outputDir?: string }
export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.WORKBENCH_HOST || '127.0.0.1'; const port = Number(env.WORKBENCH_PORT || 4310);
  const remote = !['127.0.0.1', 'localhost', '::1'].includes(host);
  const origin = env.WORKBENCH_ORIGIN || `http://127.0.0.1:${port}`;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('后台端口无效');
  const root = process.platform === 'win32' ? join(env.LOCALAPPDATA || homedir(), 'PersonalWorkbench') : join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'personal-workbench');
  const config: AppConfig = { dataDir: resolve(env.WORKBENCH_DATA_DIR || root), host, port, origin: new URL(origin).origin, remote, outputDir: env.WORKBENCH_OUTPUT_DIR ? resolve(env.WORKBENCH_OUTPUT_DIR) : undefined };
  if (remote) {
    if (!env.WORKBENCH_ORIGIN || !origin.startsWith('https://') || !env.WORKBENCH_TLS_KEY || !env.WORKBENCH_TLS_CERT || !env.WORKBENCH_PASSWORD_FILE) throw new Error('远程部署需明确 HTTPS Origin、TLS 证书/私钥及受保护的访问口令文件');
    const passwordFile = env.WORKBENCH_PASSWORD_FILE;
    if (process.platform !== 'win32' && (statSync(passwordFile).mode & 0o077) !== 0) throw new Error('访问口令文件权限必须为 0600');
    config.accessPassword = readFileSync(passwordFile, 'utf8').trim();
    if (config.accessPassword.length < 16) throw new Error('远程访问口令至少 16 个字符');
    config.tls = { key: readFileSync(env.WORKBENCH_TLS_KEY), cert: readFileSync(env.WORKBENCH_TLS_CERT) };
  }
  return config;
}
