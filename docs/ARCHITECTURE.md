# 技术架构

## 一句话

一个 Node.js 进程同时提供 API 和网页，数据放在一个目录里（SQLite 数据库 + 上传文件）。同一套代码既能在 Windows 本机双击运行，也能放进容器部署到服务器。

```
浏览器（React 单页应用）
      │  只访问同源的 /api/*，不持有任何密钥
      ▼
Node 22 · Hono ──────────────────────────────────────────────┐
  安全中间件（Host / Origin 校验、可选访问密码）               │
  模块路由  system · ai · assistant · documents · knowledge   │
            learning · research · studio                      │
      │                    │                      │           │
      ▼                    ▼                      ▼           │
  server/lib          server/ai               server/db      │
  文档提取 / 切片      统一模型适配层           node:sqlite    │
  全文检索 / 备份      调用日志 / 提示词        迁移 / 事务    │
      │                    │                      │           │
      ▼                    ▼                      ▼           │
  DATA_DIR/uploads    Anthropic · OpenAI 兼容   DATA_DIR/remo.sqlite
                      （服务端发起）                           │
└──────────────────────────────────────────────────────────────┘
```

## 技术选型与理由

| 部分 | 选择 | 为什么 |
|---|---|---|
| 运行时 | Node.js ≥ 22.13 + TypeScript（用 tsx 直接运行） | 一种语言贯穿前后端；Windows 上装一个 Node 就够 |
| Web 框架 | Hono | 小、类型好、内置 SSE 流式响应 |
| 数据库 | Node 内置 `node:sqlite` | 零安装、零编译；单文件，备份和迁移就是复制文件 |
| 全文检索 | SQLite FTS5 + trigram 分词 | 中文不需要分词器即可子串匹配；两字词回退到 LIKE |
| 文档解析 | unpdf（PDF）、mammoth（DOCX） | 纯 JS，不依赖本地编译 |
| 模型接入 | `@anthropic-ai/sdk` + 自写的 OpenAI 兼容适配器 | 两种协议覆盖绝大多数服务商，包括本机 Ollama |
| 前端 | React 19 + Vite + React Router | 成熟、构建快 |
| 样式 | 自建 CSS 设计系统（设计令牌） | 独立的视觉语言，不依赖 UI 框架，见 DESIGN.md |
| 部署 | 直接运行，或 Docker + 持久卷 | 本地与云端用同一份代码 |

刻意没有引入的东西：ORM、消息队列、独立的向量数据库、微服务、状态管理库。当前规模用不到，用到时再加。

## 目录

见 [CLAUDE.md](../CLAUDE.md) 的「结构」一节。

## 数据模型

全部定义在 `server/db/migrations/001_init.sql`。主键是短随机字符串，时间是 ISO-8601 UTC 字符串，日期是 `YYYY-MM-DD`。

```
domains ─────────────┬──────────────┬───────────────┬──────────────┐  六个学习方向
                     │              │               │              │
providers            conversations  knowledge_items plans          research_projects    content_topics
(模型来源, 密钥加密)   └ messages     ├ knowledge_tags └ tasks        ├ research_sources   └ content_refs
ai_calls (调用日志)    └ conversation ├ knowledge_links study_logs    ├ research_findings      │
                         _documents  │   (知识关联)   reviews        └ research_reports       │
                              │      └ plan_resources ─┘                                     │
                              ▼                                                              ▼
                          documents ── document_chunks（切片；embedding 列为向量检索预留） ◄──┘
                              
search_index（FTS5 虚拟表，统一的全文索引，由应用层维护）
settings / schema_migrations
```

几个要点：

- **documents 是通用的文件表**：聊天附件、知识库资料、研究来源、视觉参考图片都落在这里，按 sha256 去重。以后的「文件管理」模块直接建立在它之上。
- **search_index 一张表管全站搜索**：知识、资料切片、对话消息、研究项目与来源、选题、计划都写进同一张 FTS5 表，用 `kind` 区分。
- **向量检索已预留**：`document_chunks.embedding`（BLOB）和 `embedding_model` 两列目前为空。要启用时：给适配器接口加 `embed()`，上传时写入向量，在 `retrieveChunks()` 里把关键词得分和余弦相似度合并。几千到几万个切片的规模在内存里算余弦足够快，不需要向量数据库。

## AI 适配层

```ts
// server/ai/types.ts
interface ModelAdapter {
  stream(req: ChatRequest): AsyncGenerator<ChatEvent>;  // text | thinking | end(用量, 停止原因)
  listModels(): Promise<string[]>;
}
```

- `adapters/anthropic.ts`：官方 SDK 的流式接口。显式传入密钥和地址；不发送采样参数；按类型区分错误（密钥无效、模型不存在、限流、网络）。
- `adapters/openai-compatible.ts`：Chat Completions 协议 + SSE 解析。个别服务不认识 `stream_options` 时自动去掉重试。
- `registry.ts`：模型来源 = 数据库里的 `providers` + `.env` 提供的只读来源。模型用 `providerId::modelId` 引用（modelRef）。
- `service.ts`：**所有调用的唯一入口**。`streamChat`（对话）、`complete`（一次性文本）、`completeJson`（结构化输出，容忍代码围栏）。每次调用——成功、失败、被中止——都写入 `ai_calls`。
- `prompts.ts`：全部提示词。

接入新的模型协议：写一个实现 `ModelAdapter` 的文件 → 在 `registry.ts` 的 `createAdapter` 里加一个分支 → 在 `PRESETS` 里加预设。业务代码不用动。

### 对话如何使用上传的资料

`buildContext()`（`server/routes/chat.ts`）：附加资料总字数不超过 `AI_CONTEXT_CHARS`（默认 6 万）时载入全文；超过时用问题里的关键词检索最相关的切片，并在提示词里明确告诉模型「这不是全文」。两种情况都会把实际做法记在消息的 `context_note` 里显示给用户，不做无声截断。

### 研究实验室的引用保证

目标是不让模型凭空造引用。四层机制：

1. 提示词只提供已收集的来源，并要求每个事实标注 `[S编号]`。
2. `checkCitations()` 解析输出里的编号，指向不存在来源的会被显式标红。
3. 事实核查要求模型给出逐字引文，`quoteAppearsIn()` 在来源原文里做归一化后的子串比对；一条都对不上时，结论强制降为「未核实」。
4. 报告末尾的来源列表由数据库生成，不经过模型。

这些都有测试覆盖（`tests/api.test.ts` 的研究实验室部分）。

## 安全

- **密钥**：AES-256-GCM 加密后存库，主密钥来自 `APP_SECRET` 或自动生成的 `DATA_DIR/secret.key`。接口只返回掩码。备份里密钥被清空。
- **本机模式**（默认，`HOST=127.0.0.1`，无密码）：拒绝非本机的 Host 头（防 DNS 重绑定）；写请求必须同源（防其他网站跨站调用本地接口）。
- **联网模式**（`HOST=0.0.0.0`）：必须设置 `APP_PASSWORD`，否则拒绝启动。登录后发 30 天的签名 Cookie（HttpOnly、SameSite=Lax，HTTPS 下带 Secure）。
- 上传：限制大小和扩展名；文件以随机 id 命名存盘；下载时非图片一律作为附件返回。
- 这是单用户系统，没有多账号和权限分级。

## 扩展：加一个新模块

1. `server/db/migrations/00N_xxx.sql`：新表（只增不改旧迁移）。
2. `server/routes/xxx.ts`：导出一个 Hono 实例；需要 AI 时调用 `service.ts`。
3. `server/modules.ts`：登记一项。
4. `web/src/pages/Xxx.tsx`：页面，用 `components/ui.tsx` 的组件和 `tokens.css` 的变量。
5. `web/src/modules.tsx`：登记导航和路由。
6. 需要被全站搜索到：写入时调用 `indexDoc(kind, …)`，并在 `server/routes/knowledge.ts` 的 `LINK` 表里给出跳转地址。
7. 备份自动覆盖（整库 + 整个上传目录）；在 `server/lib/backup.ts` 的 `COUNT_TABLES` 里加上新表名即可出现在数据概况里。

### 规划中的模块如何落位（尚未实现）

| 模块 | 建立在什么之上 | 需要新增的东西 |
|---|---|---|
| **本地文件管理** | `documents` 表和上传 / 提取 / 切片流程 | 文件夹结构、批量导入、监视本地目录（仅本地部署可用） |
| **AI Agent 自动化** | `service.ts` 和各模块已有的服务函数 | 适配器接口支持工具调用；`jobs` 表 + 进程内定时器；每次运行的日志与人工确认点 |
| **向量检索** | `document_chunks.embedding` 预留列 | 适配器的 `embed()`、检索合并 |

这些只是落位说明，不是已有功能。

## 测试

- `tests/api.test.ts`、`tests/auth.test.ts`：在进程内直接调用应用，配合 `tests/helpers.ts` 里的模拟模型服务（同时模拟 OpenAI 兼容接口和 Anthropic Messages 接口的流式协议）。覆盖六个模块、两种适配器、文档提取（TXT / GBK / DOCX / PDF）、备份恢复、安全中间件、访问密码。
- `tests/e2e/smoke.ts`：用真实浏览器走完整流程，包括手机和平板宽度下的溢出检查。
