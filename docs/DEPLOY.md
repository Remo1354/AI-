# 部署与迁移

同一份代码有三种运行方式。数据格式完全相同，可以用备份包在它们之间来回迁移。

| 方式 | 适合 | 谁能访问 | 数据在哪 |
|---|---|---|---|
| A. Windows 11 本机 | 日常自用，最简单 | 只有这台电脑 | 项目下的 `data\`（可改） |
| B. 云服务器 + Docker | 手机、平板、多台电脑都要用 | 任何地方（需密码） | Docker 持久卷 |
| C. Linux 服务器直接运行 | 不想用 Docker | 同上 | 你指定的目录 |

> **关于 Claude Code 云端会话**：那是写代码用的临时环境，会话结束后磁盘会被回收。它不是部署目标——不要把真正的学习数据只放在那里。代码靠 `git push` 保存，数据靠备份包带走。

---

## A. Windows 11 本机

1. 安装 Node.js 22 或更高版本：<https://nodejs.org> 下载 LTS 安装包，或在终端运行 `winget install OpenJS.NodeJS.LTS`。
2. 取得代码：`git clone <仓库地址>`，或在 GitHub 页面下载 ZIP 并解压。
3. 双击 **`bootstrap.cmd`**。它会检查环境、创建 `.env`、安装依赖、构建页面。脚本检测不到合适的 Node.js 时会询问是否用 winget 安装。
4. 双击 **`start.cmd`**。浏览器自动打开 <http://127.0.0.1:8787>。关闭那个终端窗口即停止。

常见情况：

- **提示无法运行脚本**：用 `.cmd` 文件启动即可（它们已带 `-ExecutionPolicy Bypass`）；或在 PowerShell 里执行 `powershell -ExecutionPolicy Bypass -File scripts\start.ps1`。
- **端口被占用**：把 `.env` 里的 `PORT` 改成别的数字。
- **想把数据放到 D 盘或网盘同步目录**：把 `.env` 里的 `DATA_DIR` 改成例如 `D:\RemoData`。注意不要让两台电脑同时打开同一个同步目录里的数据库。
- **想让家里其他设备访问**：`.env` 里设 `HOST=0.0.0.0` 和 `APP_PASSWORD`，然后用 `http://<这台电脑的局域网 IP>:8787` 访问。
- **开机自动启动**：把 `start.cmd` 的快捷方式放进「启动」文件夹（Win + R 输入 `shell:startup`）。

升级：`git pull`（或重新下载解压覆盖，保留 `data\` 和 `.env`），然后再运行一次 `bootstrap.cmd`。数据库结构变化会在启动时自动迁移。

---

## B. 云服务器 + Docker（推荐的云端方案）

需要一台装了 Docker 的服务器（任意云厂商的轻量服务器即可，1 核 1G 内存足够）。

```bash
git clone <仓库地址> remo && cd remo
cp .env.example .env
# 编辑 .env：至少设置一个足够长的 APP_PASSWORD
docker compose up -d --build
```

打开 `http://<服务器 IP>:8787`，输入密码进入。

- 数据在名为 `remo-data` 的持久卷里。`docker compose down`、重建镜像、升级都不会丢数据；只有 `docker compose down -v` 或删除卷才会。
- 默认每 24 小时自动备份一次，保留 7 份，放在卷内的 `backups/`，可在「设置 → 数据与备份」下载。**自动备份和数据在同一块磁盘上**，防得住误删，防不住磁盘损坏——请定期下载一份到别处。
- 没有设置 `APP_PASSWORD` 时服务拒绝启动。

升级：

```bash
git pull && docker compose up -d --build
```

### 加上 HTTPS

在公网上使用应当走 HTTPS，否则密码和内容是明文传输。最省事的办法是在前面放一个 Caddy，它会自动申请和续期证书。在 `docker-compose.yml` 里加一个服务，并把 `remo` 的 `ports` 一段删掉（不再直接对外）：

```yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    command: caddy reverse-proxy --from 你的域名.com --to remo:8787
    volumes:
      - caddy-data:/data

volumes:
  remo-data:
  caddy-data:
```

把域名解析到服务器后 `docker compose up -d`，访问 `https://你的域名.com`。

也可以不暴露公网：只在服务器本机监听，通过 Tailscale 之类的组网工具或 SSH 隧道访问。

---

## C. Linux 服务器直接运行

```bash
git clone <仓库地址> /opt/remo && cd /opt/remo
./scripts/bootstrap.sh
# 编辑 .env：HOST=0.0.0.0、APP_PASSWORD=…、DATA_DIR=/var/lib/remo、AUTO_BACKUP_HOURS=24
```

用 systemd 托管（`/etc/systemd/system/remo.service`）：

```ini
[Unit]
Description=Remo AI Workspace
After=network.target

[Service]
WorkingDirectory=/opt/remo
ExecStart=/usr/bin/node scripts/run-prod.mjs
Restart=on-failure
User=remo

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now remo
```

HTTPS 同样建议用 Caddy 或 Nginx 反向代理到 `127.0.0.1:8787`。

---

## 迁移数据

在任意两种部署之间搬家，步骤都一样：

1. **旧环境**：设置 → 数据与备份 → 下载完整备份（或 `npm run backup`）。得到一个 `remo-backup-日期.zip`。
2. **新环境**：装好并启动平台。
3. **新环境**：设置 → 数据与备份 → 从备份恢复，选择那个 zip（或先停止服务，运行 `npm run restore -- 文件.zip`）。
4. **新环境**：设置 → 模型，重新填写 API Key（备份里不含密钥）。

恢复时，新环境原有的数据不会被删除，而是改名保留在数据目录里（带 `.before-restore-时间戳` 后缀），确认无误后可以手动删掉。

备份包里有什么：数据库的一致性快照、全部上传文件、一个说明文件。旧版本导出的备份可以恢复到新版本（启动时自动执行缺少的数据库迁移）；反过来不行。

---

## 环境变量

完整列表和说明见 [.env.example](../.env.example)。最常用的几个：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 改为 `0.0.0.0` 才能被其他设备访问，此时必须有密码 |
| `PORT` | `8787` | |
| `DATA_DIR` | `./data` | 数据目录，可以是任何有写权限的位置 |
| `APP_PASSWORD` | 空 | 访问密码 |
| `AUTO_BACKUP_HOURS` | `0` | 自动备份间隔（小时），Docker 部署默认 24 |
| `MAX_UPLOAD_MB` | `40` | 单个文件大小上限 |
| `ALLOWED_HOSTS` | 空 | 本机无密码模式下额外允许的访问域名 |

## 排查

运行 `npm run doctor`（Windows 同样）会检查 Node 版本、内置数据库、依赖、数据目录是否可写、端口、安全配置和 Git 状态，并给出每一项的处理办法。
