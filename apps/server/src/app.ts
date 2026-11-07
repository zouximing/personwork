import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import serveStatic from '@fastify/static';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { localDate, weekRange } from '@workbench/contracts';
import type { AppConfig } from './config.js';
import { Workbench } from './workbench.js';
import { SecretVault } from './secrets.js';
import { BackupService } from './backup.js';
import { AppError } from './errors.js';
import { registerManagementRoutes } from './management.js';
import { registerSourceRoutes } from './source-settings.js';
import { registerModelRoutes, type ModelMessage, type ToolDefinition } from './models.js';
import { ExecutionService, registerExecutionRoutes } from './executions.js';
import { join } from 'node:path';
import { registerDashboardRoutes } from './dashboard.js';

export async function createApp(config: AppConfig) {
  const app = Fastify({ logger: false, bodyLimit: 42 * 1024 * 1024, ...(config.tls ? { https: config.tls } : {}) });
  await app.register(cookie);
  const store = new Workbench(config.dataDir); const vault = new SecretVault(config.dataDir); const backups = new BackupService(store, vault);
  const sources = registerSourceRoutes(app, store, vault);
  const models = registerModelRoutes(app, store, vault);
  const executions = new ExecutionService(store, {
    profile(id) {
      const model = models.listModels().find(value => value.id === id); if (!model) throw new AppError(404, '模型配置不存在');
      return { ...model, allowInternal: model.allowInternal && model.kind !== 'deepseek' && model.upstreamLocation === 'internal' };
    },
    chat: (id, messages, options) => models.chat(id, messages as unknown as ModelMessage[], { ...options, tools: options.tools as unknown as ToolDefinition[] })
  }, sources, config.outputDir ?? join(config.dataDir, 'artifacts'));
  registerExecutionRoutes(app, executions);
  const csrfToken = randomBytes(32).toString('hex');
  const sessions = new Map<string, number>(); const attempts = new Map<string, { count: number; until: number }>();
  const expectedHost = new URL(config.origin).host;
  let restoring = false;
  const pendingWrites = new Set<unknown>();
  async function restoreSafely(operation: () => Promise<void>): Promise<void> {
    if (restoring || pendingWrites.size > 1 || sources.isBusy() || models.isBusy() || executions.isBusy()) throw new AppError(409, '仍有同步、模型、执行或保存请求进行中，请等待结束后再恢复');
    restoring = true; sources.stopScheduler();
    try { await operation(); }
    finally { restoring = false; sources.startScheduler(); }
  }
  let backupStatus = '未运行';
  function snapshot() { try { backups.daily(); backupStatus = '本机保护快照已保存'; } catch { backupStatus = '保护快照失败，请检查凭据存储与目录权限'; } }
  snapshot(); const backupTimer = setInterval(snapshot, 60 * 60 * 1000); backupTimer.unref();
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.headers.host !== expectedHost || (request.headers.origin && request.headers.origin !== config.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, '请求来源不受信任');
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (!['GET', 'HEAD'].includes(request.method) && request.headers['x-workbench-csrf'] !== csrfToken) throw new AppError(403, '请求校验失败，请重新打开工作台');
      const session = request.cookies.pwb_session;
      const authenticated = !config.remote || !!(session && (sessions.get(session) ?? 0) > Date.now());
      if (!authenticated && !['/api/session', '/api/login'].includes(request.url)) throw new AppError(401, '请先登录工作台');
      if (!['GET', 'HEAD'].includes(request.method)) {
        if (restoring) throw new AppError(503, '数据正在恢复，请保留输入并稍后重试');
        pendingWrites.add(request);
      }
    }
  });
  app.addHook('onResponse', async request => { pendingWrites.delete(request); });
  app.addHook('onRequestAbort', async request => { pendingWrites.delete(request); });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) { reply.code(400).send({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；') }); return; }
    if (error instanceof AppError) { reply.code(error.statusCode).send({ error: error.message }); return; }
    const status = typeof error === 'object' && error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    reply.code(status >= 400 && status < 500 ? status : 500).send({ error: status === 413 ? '输入超过允许大小，原数据未改变' : '操作未确认成功，请保留输入；检查后台和存储后重试' });
  });
  app.get('/api/session', async request => ({ csrfToken, authenticated: !config.remote || (sessions.get(request.cookies.pwb_session ?? '') ?? 0) > Date.now() }));
  app.post('/api/login', async (request, reply) => {
    const input = z.object({ password: z.string().max(1024) }).strict().parse(request.body);
    const attempt = attempts.get(request.ip);
    if (attempt && attempt.until > Date.now() && attempt.count >= 5) throw new AppError(429, '登录尝试过多，请稍后重试');
    const actual = createHash('sha256').update(input.password).digest(); const expected = createHash('sha256').update(config.accessPassword ?? '').digest();
    if (!config.remote || !timingSafeEqual(actual, expected)) { attempts.set(request.ip, { count: (attempt?.until ?? 0) > Date.now() ? (attempt?.count ?? 0) + 1 : 1, until: Date.now() + 15 * 60 * 1000 }); throw new AppError(401, '访问口令不正确'); }
    attempts.delete(request.ip); const token = randomBytes(32).toString('hex'); sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
    reply.setCookie('pwb_session', token, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 8 * 60 * 60 }); return { authenticated: true };
  });
  app.post('/api/logout', async (request, reply) => { sessions.delete(request.cookies.pwb_session ?? ''); reply.clearCookie('pwb_session', { path: '/' }); return { authenticated: false }; });
  app.get('/api/bootstrap', async () => ({ tasks: store.listTasks(), prompts: store.listPrompts(), sources: sources.listSources(), today: localDate(), week: weekRange(localDate()), timezone: 'Asia/Shanghai', dataDir: config.dataDir, outputDir: config.outputDir ?? `${config.dataDir}/artifacts`, stage: '正式工程 · 本地运行', backupStatus }));
  app.get('/api/tasks', async () => ({ items: store.listTasks() }));
  app.post('/api/tasks', async (request, reply) => { const task = store.createTask(request.body); reply.code(201); return task; });
  app.patch<{ Params: { id: string } }>('/api/tasks/:id', async request => store.patchTask(request.params.id, request.body));
  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async request => {
    if (sources.isBusy() || models.isBusy() || executions.isBusy()) throw new AppError(409, '仍有同步、模型或执行请求进行中，请等待结束后再删除');
    return store.deleteTask(request.params.id, request.body);
  });
  app.get<{ Params: { id: string } }>('/api/history/:id', async request => ({ items: store.getHistory(request.params.id) }));
  app.get('/api/prompts', async () => ({ items: store.listPrompts() }));
  app.post('/api/prompts', async request => store.savePrompt(request.body));
  const management = registerManagementRoutes(app, store);
  registerDashboardRoutes(app, store, () => sources.listSources());
  let cycleStatus = '';
  const checkCycles = () => {
    if (restoring) return;
    try { management.checkCycles(); cycleStatus = ''; } catch { cycleStatus = '月末汇总检查失败，将于下次检查重试'; }
  };
  checkCycles(); const cycleTimer = setInterval(checkCycles, 60 * 1000); cycleTimer.unref();
  app.get('/api/production/status', () => ({ error: cycleStatus }));
  app.post('/api/backups/export', async (request, reply) => {
    const { password } = z.object({ password: z.string().min(12).max(1024) }).strict().parse(request.body);
    const data = await backups.export(password);
    return reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename="workbench-${localDate()}.pwb"`).send(data);
  });
  app.post('/api/backups/restore', async request => {
    const { password, content } = z.object({ password: z.string().max(1024), content: z.string().max(42 * 1024 * 1024), confirm: z.literal(true) }).strict().parse(request.body);
    await restoreSafely(() => backups.restore(Buffer.from(content, 'base64'), password)); return { restored: true };
  });
  app.get('/api/backups/snapshots', async () => ({ items: backups.listSnapshots() }));
  app.post<{ Params: { name: string } }>('/api/backups/snapshots/:name/restore', async request => {
    z.object({ confirm: z.literal(true) }).strict().parse(request.body);
    await restoreSafely(() => backups.restoreProtected(request.params.name)); return { restored: true };
  });
  const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  // Bundled and source entrypoints both live under apps/server/{src,dist}.
  if (existsSync(webRoot)) {
    await app.register(serveStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在' }) : reply.type('text/html').sendFile('index.html'));
  }
  app.addHook('onClose', async () => { clearInterval(backupTimer); clearInterval(cycleTimer); sources.stopScheduler(); await executions.close(); await sources.close(); store.close(); });
  return app;
}
