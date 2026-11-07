import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { encrypt, decrypt } from './crypto.js';
import { AppError } from './errors.js';

function dpapi(input: Buffer, operation: 'Protect' | 'Unprotect'): Buffer {
  const code = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $e=[Text.Encoding]::UTF8.GetBytes('personal-workbench/master/v1'); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  try {
    return Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { input: input.toString('base64'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }).toString().trim(), 'base64');
  } catch { throw new AppError(503, 'Windows 凭据保护不可用，未退回明文存储'); }
}
export function protectWindowsDirectory(dir: string): void {
  if (process.platform !== 'win32') return;
  const script = `$d=[Console]::In.ReadToEnd(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18'); $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'; foreach($principal in @($sid,$system)) { $rule=[Security.AccessControl.FileSystemAccessRule]::new($principal,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule) }; [IO.Directory]::SetAccessControl($d,$acl)`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 });
  } catch { throw new AppError(503, '无法限制数据目录访问权限，已停止保护存储初始化'); }
}
export class SecretVault {
  private master?: Buffer;
  constructor(private readonly dir: string) {}
  private key(): Buffer {
    if (this.master) return this.master;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
      const path = join(this.dir, 'master.protected');
      protectWindowsDirectory(this.dir);
      if (!existsSync(path)) {
        writeFileSync(path, dpapi(randomBytes(32), 'Protect'), { mode: 0o600, flag: 'wx' });
      }
      this.master = dpapi(readFileSync(path), 'Unprotect');
    } else {
      const path = process.env.WORKBENCH_MASTER_KEY_FILE;
      if (!path || !isAbsolute(path)) throw new AppError(503, 'Linux 需先配置独立的绝对路径主密钥文件');
      const stat = statSync(path);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new AppError(503, 'Linux 主密钥文件须属于运行用户且权限为 0600');
      this.master = readFileSync(path);
    }
    if (this.master.length !== 32) throw new AppError(503, '主密钥格式不正确');
    return this.master;
  }
  private path(id: string): string {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new AppError(400, '凭据引用无效');
    return join(this.dir, 'secrets', `${id}.protected`);
  }
  async set(id: string, value: string): Promise<void> {
    const encrypted = encrypt(Buffer.from(value), this.key(), `pwb-secret:${id}`);
    const path = this.path(id); mkdirSync(join(this.dir, 'secrets'), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
    finally { rmSync(temporary, { force: true }); }
  }
  async get(id: string): Promise<string | undefined> {
    const path = this.path(id); if (!existsSync(path)) return undefined;
    try { return decrypt(readFileSync(path), this.key(), `pwb-secret:${id}`).toString('utf8'); }
    catch { throw new AppError(503, '凭据无法解密，请在原运行账号下使用或明确更换凭据'); }
  }
  async remove(id: string): Promise<void> { rmSync(this.path(id), { force: true }); }
  protect(data: Buffer, context: string): Buffer { return encrypt(data, this.key(), context); }
  unprotect(data: Buffer, context: string): Buffer { return decrypt(data, this.key(), context); }
}
