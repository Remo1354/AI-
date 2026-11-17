# Remo AI Workspace

以个人 AI 学习平台为核心的工作区：AI 助手、知识库、学习中心、研究实验室和内容创作中心（Remo叠绘）在同一个系统里，数据长期积累，可以在自己的电脑或自己的服务器上运行。

| 模块 | 能做什么 |
|---|---|
| **总览** | 今日任务、学习节奏、当前计划、各方向进度、最近的知识与资料、研究进展、AI 入口 |
| **AI 助手** | 多轮对话与历史记录；上传 PDF / DOCX / TXT 后基于资料答疑；五种教学模式；随时切换模型；回答一键存入知识库 |
| **知识库** | 笔记与资料、分类与标签、中文全文检索（含上传文件的正文）、AI 提炼摘要和知识点、知识互相关联、导出 Markdown |
| **学习中心** | AI 制定学习计划（草稿确认后才保存）、任务、每日学习记录、连续学习天数、阶段总结；**复习卡片**按记忆规律安排复习，可让 AI 从知识库内容出题 |
| **研究实验室** | 研究项目、带编号的来源、观点 / 陈述 / 时间线、事实核查、结构化报告——引用可追溯并由程序校验 |
| **内容创作** | 选题板、发布日历、大纲与脚本、视觉参考、发布数据与复盘，独立的「叠绘工作室」视觉风格 |
| **设置** | 模型接入（Anthropic 与任意 OpenAI 兼容接口）、调用记录、备份与恢复、学习方向、主题 |

## 快速开始

需要 [Node.js](https://nodejs.org) 22.13 或更高版本。不需要安装数据库，也不需要编译工具。

### Windows 11

1. 安装 Node.js LTS（官网安装包，或在终端运行 `winget install OpenJS.NodeJS.LTS`）。
2. 下载或克隆本仓库，双击根目录的 **`bootstrap.cmd`**（首次安装依赖并构建）。
3. 双击 **`start.cmd`**，浏览器会自动打开 <http://127.0.0.1:8787>。

也可以在 PowerShell 里运行 `scripts\bootstrap.ps1` 和 `scripts\start.ps1`。

### macOS / Linux / 云端开发环境

```bash
./scripts/bootstrap.sh    # 检查环境、安装依赖、构建
./scripts/start.sh        # 启动，打开 http://127.0.0.1:8787
```

### 部署到自己的服务器（云端可访问、数据持久化）

```bash
cp .env.example .env      # 至少填写 APP_PASSWORD
docker compose up -d --build
```

数据保存在持久卷里，每天自动留一份备份。详见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 接入 AI 模型

打开 **设置 → 模型 → 添加模型服务**，选择服务商并填写 API Key，点「测试连接」确认可用。

- 支持 **Anthropic Claude**，以及任何 **OpenAI 兼容接口**：OpenAI、DeepSeek、通义千问、Kimi、智谱、硅基流动、OpenRouter、Google Gemini（兼容模式）、本机 Ollama 等。
- API Key 只保存在服务端，加密后写入数据库；网页上只显示掩码，备份文件里也不包含。
- 没有配置模型时，对话、总结、规划等 AI 功能会明确提示「尚未配置」，其余功能照常使用。

也可以在 `.env` 里用 `ANTHROPIC_API_KEY` 等环境变量提供，见 [.env.example](.env.example)。

## 你的数据在哪里

所有数据都在 **数据目录**（默认是项目下的 `data/`，可用 `.env` 里的 `DATA_DIR` 改到任何位置）：

```
data/
  remo.sqlite     数据库（单个文件）
  uploads/        上传的原始文件
  backups/        自动备份（开启后）
  secret.key      加密 API Key 用的主密钥
```

这个目录不会进入 Git。**备份和迁移**：

- 网页：设置 → 数据与备份 → 「下载完整备份」/「从备份恢复」
- 命令行：`npm run backup`、`npm run restore -- 备份文件.zip`
- 知识库还可以单独导出为 Markdown（每条知识一个 `.md` 文件，可直接放进 Obsidian）

换电脑或从本地搬到服务器：在旧机器下载完整备份 → 新机器装好平台 → 从备份恢复 → 重新填写 API Key。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式：后端自动重启 + 前端热更新（<http://127.0.0.1:5173>） |
| `npm start` | 正式运行（需要时自动构建前端） |
| `npm run check` | 类型检查 + 接口测试 |
| `npm run test:e2e` | 浏览器端到端测试（需要本机有 Playwright） |
| `npm run doctor` | 环境自检 |
| `npm run backup` / `npm run restore -- 文件` | 备份 / 恢复 |

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 技术架构、数据模型、如何扩展新模块
- [docs/DESIGN.md](docs/DESIGN.md) — 设计系统：颜色、字体、图标、组件规范
- [docs/DEPLOY.md](docs/DEPLOY.md) — Windows 本地、云端服务器、迁移
- [progress.md](progress.md) — 已完成的内容与验证情况
- [TODO.md](TODO.md) — 接下来要做的事
- [CLAUDE.md](CLAUDE.md) — 给 AI 编程助手的项目说明（在新会话中恢复开发时先读它）
