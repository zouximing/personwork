import { readConfig } from './config.js';
import { createApp } from './app.js';
try {
  const config = readConfig(); const app = await createApp(config);
  await app.listen({ host: config.host, port: config.port });
  process.stdout.write(`个人工作台：${config.origin}\n`);
  const close = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
} catch { process.stderr.write('工作台启动失败。请检查端口、数据目录、主密钥及远程 HTTPS/认证配置；未输出配置或凭据。\n'); process.exitCode = 1; }
