import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
const path = process.env.WORKBENCH_MASTER_KEY_FILE;
if (process.platform === 'win32' || !path || !isAbsolute(path)) {
  console.error('仅用于 Linux。请先将 WORKBENCH_MASTER_KEY_FILE 设为业务数据目录之外的绝对路径。'); process.exitCode = 1;
} else {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
  console.log('主密钥已创建；未显示密钥，不会覆盖已有文件。请独立安全备份。');
}
