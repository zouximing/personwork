# Repository Guidelines

## 项目结构与模块边界

这是单用户个人工作台，核心业务为“个人任务”和“管理”。修改前阅读 `README.md`、`docs/个人工作台需求文档.md` 及相关实施文档。

- `apps/web/src/`：React 页面、共用组件和 `styles.css`；页面置于 `pages/`，组件置于 `components/`。
- `apps/server/src/`：Fastify HTTP 服务、SQLite 持久化、来源同步、模型执行和备份。
- `packages/contracts/src/`：前后台共享 TypeScript 类型及 Zod 校验；接口变更同步更新双方。
- `tests/`：单元与集成测试；`tests/e2e/`：浏览器回归；`scripts/`：重启验证和部署辅助脚本。
- `docs/implementation/`：技术方案、需求追溯、验证与部署记录。`prototype/` 为只读参考，其截图不属于正式界面资源。

## 构建、测试与本地开发

使用 Node.js 24 和 npm，在仓库根目录执行：

- `npm ci`：按锁文件安装依赖。
- `npm run dev`：同时启动后台与 Vite 开发服务。
- `npm run build`：构建前端与后台；`npm start`：启动已构建的后台。
- `npm run check`：依次执行类型检查、ESLint、Vitest 和生产构建。
- `npm run test:e2e`：运行 Playwright，自动构建并启动独立测试后台；需要本机 Chrome，端口 4310 须空闲。
- `npm run test:restart`：验证独立后台进程重启后的持久化；先运行构建。

开发启动前设置独立数据目录，例如 PowerShell：`$env:WORKBENCH_DATA_DIR = 'D:\workbench-dev-data'`。每次启动使用同一目录；当前机器默认目录的快照限制见 README。

## 代码风格与命名

使用严格 TypeScript、ES modules、两空格缩进和分号，保持所在文件的引号风格。React 组件和类型用 PascalCase，函数与变量用 camelCase，后台模块用小写连字符文件名。文件采用 UTF-8、LF；遵循 `.gitattributes`。ESLint 要求零警告，当前没有独立格式化工具。修改保持聚焦，避免顺手重排无关代码。

## 测试要求

Vitest 匹配 `tests/**/*.test.ts`；Playwright 匹配 `tests/e2e/*.spec.ts`。定向验证示例：`npm test -- tests/api.test.ts`。行为变更应覆盖正常路径、失败路径，以及相关的修订冲突、持久化或隐私边界。测试使用临时目录和合成数据；当前未配置覆盖率阈值。本地 HTTP 夹具通过不能证明公司 PingCode、GitLab、真实模型或 Linux 部署已验收。

## 提交与拉取请求

历史目前仅有 `chore: preserve approved requirements and prototype baseline`，不足以认定完整提交规范；建议采用 `feat:`、`fix:`、`docs:`、`test:` 等前缀，主题简短明确。PR 说明变更目的、关联需求或问题、影响范围、验证命令与结果、未验证限制；界面变更附截图。行为变更同步更新需求追溯与验证记录，提交前逐项复核差异。

## 安全与配置

来源地址、认证和同步范围通过设置配置。凭据、业务数据库、密钥及未脱敏日志不得进入仓库、提示词或测试夹具。GitLab 保持只读；PingCode 评论须预览和明确授权，状态覆盖仍受阻。AI 执行限于授权工具和产物验证；内部资料不得发送给 DeepSeek 或未知上游。部署与恢复操作先阅读 `docs/implementation/部署说明.md`，涉及真实数据替换或生产发布时取得明确确认。
