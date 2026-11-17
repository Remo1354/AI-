# Remo AI Workspace — 项目说明

以个人 AI 学习平台为核心的工作区（单用户）。当前包含：总览、AI 助手、知识库、学习中心、研究实验室、内容创作中心。长期方向是在同一套架构上继续接入本地文件管理和 AI Agent 自动化——但只在真正要做的时候再加，不为未来功能提前铺设施。

界面和文档使用简体中文。用户是产品的唯一使用者，不是程序员：给用户看的文字要直白，不要出现内部术语。

## 新会话恢复开发

```bash
./scripts/bootstrap.sh      # 安装依赖 + 构建 + 环境自检（Windows: scripts\bootstrap.ps1）
npm run check               # 类型检查 + 接口测试，应全部通过
```

然后读 `progress.md`（做到哪了、哪些验证过）和 `TODO.md`（接下来做什么）。

**持久化规则（重要）**

- 云端开发容器是临时的。代码只有 `git push` 之后才算保存；每完成一个可用的阶段就提交并推送。
- `data/`（数据库、上传文件、密钥）永远不进 Git——仓库是公开的。需要保留开发数据时运行 `npm run backup`。
- 推送被拒绝（403）说明 Claude GitHub App 没有这个仓库的写权限：告诉用户去授权，不要绕过。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 后端 `tsx watch`（8787）+ Vite（5173，/api 代理到后端） |
| `npm start` | 正式模式：单进程提供 API 和 `dist/web` |
| `npm run check` | `tsc --noEmit` + `node --test`（tests/*.test.ts） |
| `npm run test:e2e [-- --shots]` | 浏览器冒烟测试，自带模拟模型服务和临时数据目录 |
| `npm run doctor` | 环境自检 |

改完代码至少跑 `npm run check`；改了界面或交互再跑 `npm run test:e2e`。

## 结构

```
server/
  index.ts            入口：环境检查、启动、自动备份
  app.ts              Hono 应用：安全中间件、登录、挂载模块、静态页面
  modules.ts          ★ 后端模块注册表
  config.ts           读取 .env
  db/                 node:sqlite 封装、迁移（migrations/*.sql）、种子数据
  ai/                 ★ 统一模型适配层
    types.ts            ModelAdapter 接口
    adapters/           anthropic.ts（官方 SDK）、openai-compatible.ts
    registry.ts         模型来源、预设、modelRef 解析
    service.ts          streamChat / complete / completeJson + 调用日志
    prompts.ts          全部提示词
  lib/                documents（上传/提取/切片）、search（FTS）、knowledge、backup、crypto、extract
  routes/             每个模块一个文件
web/src/
  modules.tsx         ★ 前端模块注册表（导航 + 路由）
  pages/              每个模块一个文件
  components/         Shell（外壳、搜索）、ui（通用组件）
  lib/                api（唯一的后端通道）、store（全局状态、useData）、format
  styles/             tokens.css（设计令牌）、base.css（组件）、pages.css（页面）
tests/                api.test.ts、auth.test.ts、helpers.ts（模拟模型服务）、e2e/smoke.ts
scripts/              bootstrap / start（sh + ps1）、doctor、dev、run-prod、backup、restore
docs/                 ARCHITECTURE、DESIGN、DEPLOY
```

## 约定

**后端**
- 新增数据表或字段：在 `server/db/migrations/` 加一个编号递增的 `.sql` 文件。已提交的迁移不要修改——用户的数据库已经执行过。
- 所有模型调用都走 `server/ai/service.ts`，不要在路由里直接调用适配器或 SDK。它负责解析模型、记录调用日志、统一错误。
- 提示词集中在 `server/ai/prompts.ts`。
- 错误用 `HttpError`（`server/lib/http.ts`）或 `AiError` 抛出，`app.ts` 统一转成 `{ error: { code, message } }`。message 是给用户看的中文。
- 内容变更后维护全文索引：`indexDoc` / `removeDoc`（`server/lib/search.ts`）。
- API Key 只在服务端解密；任何返回给前端的对象都不能带明文密钥。

**AI 行为**
- 未配置模型时抛 `AiError('not_configured')`（HTTP 409），前端用 `<AiNotice />` 提示。不要伪造 AI 输出。
- AI 生成的计划、总结、脚本都先返回草稿，用户确认后才写库。
- 研究实验室的引用必须可追溯：模型只能引用已收集的来源（`[S1]`），`checkCitations` 校验编号，`quoteAppearsIn` 逐字校验引文，来源列表由数据库生成而不是模型。改动这部分时保持这些保证，并保留对应测试。

**前端**
- 颜色、字号、间距只用 `tokens.css` 里的变量；不要写死色值。学习方向的颜色通过 `data-color` 属性取 `--c`。
- 图标统一用 lucide-react，线宽由 CSS 控制（1.6–1.7）。
- 「今天」以浏览器本地日期为准（`localDate()`），请求时显式传给后端。
- 新模块在 `web/src/modules.tsx` 和 `server/modules.ts` 各登记一项即可出现在导航和路由里。

**Windows 兼容**
- 不引入需要本地编译的依赖（数据库用 Node 内置的 `node:sqlite`，文档解析用纯 JS 库）。
- `.ps1` / `.cmd` 脚本只写 ASCII 字符（Windows PowerShell 5.1 读无 BOM 的 UTF-8 会乱码）；中文说明放在 `scripts/doctor.mjs` 的输出里。
- 脚本里不要依赖 shell 特性；跨平台逻辑写成 Node 脚本。

## 容易踩的坑

- `node:sqlite` 在 Node 22 会打印 ExperimentalWarning，`server/index.ts` 里只屏蔽了这一条。布尔值和 `undefined` 不能直接绑定，统一经过 `server/db/index.ts` 的 `norm()`。
- FTS5 用 trigram 分词：少于 3 个字符的查询词（常见的两字中文词）自动回退到 LIKE，见 `search()`。
- Anthropic 适配器显式传入 `apiKey` 和 `baseURL`——云端开发容器里有无关的 `ANTHROPIC_BASE_URL` 环境变量，不能让 SDK 读到它。不要发送 `temperature` 等采样参数（新模型会拒绝）。
- 本机模式（HOST=127.0.0.1 且无密码）会校验 Host 和 Origin。通过别的域名访问（例如预览地址）需要设置 `ALLOWED_HOSTS`。
- 这个容器里的 Playwright 不能用含中文的文件路径调用 `setInputFiles`（静默失败）；用 `{ name, mimeType, buffer }` 形式传文件。
- 还没有用真实的模型 API Key 验证过（开发环境没有密钥）；适配器是对着模拟服务测试的。有密钥时先在「设置 → 模型」点「测试连接」。
