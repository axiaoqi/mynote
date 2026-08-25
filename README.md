# MyNote 私有便签

MyNote 是一个适合家庭和个人使用的私有便签网站，采用 Flask、SQLite、Jinja 和原生 JavaScript/CSS 构建。它可以运行在 Windows、Docker Desktop 或群晖 Container Manager 中，电脑、手机和平板通过浏览器即可使用。

项目不依赖外部 CDN，账号、便签、图片和登录密钥全部保存在自己的设备上。

> MyNote 是独立开源项目，与 WPS 或金山办公没有隶属、授权或合作关系，也不包含其商标和专有素材。

## 主要功能

- 家庭多账号，用户数据完全隔离；首位注册者自动成为管理员。
- 首页默认分组、自定义分组、搜索、置顶和按更新时间排序。
- 便签无需单独填写名称，直接编辑正文并自动保存。
- 标题、粗体、斜体、下划线、删除线、列表、清单、引用和链接等富文本功能。
- PNG、JPG、WEBP 和 GIF 图片上传，单张图片最大 10 MB。
- 回收站、恢复、永久删除和清空回收站。
- 电脑三栏布局，手机和平板自适应；手机便签列表支持左滑删除。
- URL 保存当前分组和便签位置，刷新后可以回到原位置。
- 便签版本冲突保护，避免手机和电脑同时编辑时静默覆盖。
- TXT、Markdown、MyNote JSON 和完整 ZIP 备份导入。
- Markdown、JSON 和包含图片的完整 ZIP 备份导出。
- 登录会话按最后使用时间保留 30 天。
- 同一 IP 在 15 分钟内连续登录失败 3 次后，暂停登录 15 分钟。
- CSRF 防护、密码安全哈希、富文本清洗、危险链接过滤和附件访问隔离。

## 快速开始

### Docker Desktop

Docker 方式不需要在电脑上单独安装 Python。

1. 安装并启动 Docker Desktop。
2. 下载项目并进入项目目录。
3. 在 PowerShell 中运行：

```powershell
docker compose up -d --build
```

4. 打开 [http://127.0.0.1:5055](http://127.0.0.1:5055)。

常用管理命令：

```powershell
docker compose ps
docker compose logs -f mynote
docker compose stop
docker compose start
```

`docker compose stop` 只停止服务，不会删除 `instance` 中的数据。

### 群晖 Container Manager（推荐长期运行）

群晖不需要安装 Python，也不需要配置 Web Station。

1. 将整个项目上传到群晖本机存储，例如 `/volume1/docker/mynote`。
2. 打开 **Container Manager → 项目 → 新增**。
3. 项目名称填写 `mynote`，路径选择项目目录。
4. 使用项目自带的 `docker-compose.yml` 创建并启动项目。
5. 浏览器访问 `http://群晖IP:5055`。

容器使用 Python 3.12 和 Waitress，异常退出或群晖重启后会自动启动。数据库、图片和会话密钥通过目录映射保存在项目的 `instance` 文件夹中，重新构建容器不会删除这些数据。

SQLite 数据目录必须位于群晖本机存储，不建议将 `instance` 放在远程 SMB、NFS 或云盘同步目录中。

### Windows 原生运行

Windows 原生方式需要先安装 [uv](https://docs.astral.sh/uv/)。安装后双击项目中的 `start.bat`。

首次启动会自动创建 Python 环境、安装依赖并初始化数据库。启动窗口会显示实际地址：

- 本机访问：通常为 `http://127.0.0.1:5000`。
- 手机访问：例如 `http://192.168.1.20:5000`。

如果端口 `5000` 已被占用或被 Windows 保留，启动脚本会自动尝试 `8055`–`8057`。请以窗口显示的地址为准。

手机和电脑必须连接同一局域网，运行服务的窗口需要保持打开。按 `Ctrl+C` 可以停止服务。Windows 防火墙首次询问时，建议只允许“专用网络”。

## 第一次使用

1. 只在可信局域网中启动新安装的 MyNote。
2. 立即注册第一个账号；第一个账号会自动成为管理员。
3. 管理员在左下角账号菜单中创建或确认家庭账号后，建议关闭开放注册。
4. 其他家庭成员使用相同局域网地址登录，各自的便签和图片互不可见。

如果浏览器在旧版本中已经丢失登录 Cookie，升级后需要重新登录一次。之后正常关闭 Safari 或 Chrome 不会退出，连续 30 天未访问才会过期。无痕模式、手动清除网站数据或系统清理 Cookie 后仍需重新登录。

## 常用操作

### 分组和便签

- “首页”是未加入自定义分组的默认分组，不是全部便签的汇总页。
- 点击分组标题右侧的加号可以新建分组。
- 点击分组右侧的更多按钮可以重命名或删除分组；删除分组后，其中的便签会回到首页。
- 新建便签后直接输入正文即可，内容会自动保存。
- 新建的空白便签会在离开后自动丢弃，不会留在列表或回收站中。
- 清空已有便签内容时，在仍停留于编辑页期间可以撤销；离开编辑页后空白便签才会被处理。

### 导入与导出

在左下角账号菜单的“账号与数据”中可以使用：

- 导入：`.txt`、`.md`、`.markdown`、MyNote `.json` 和 MyNote 完整 `.zip` 备份。
- 导出 Markdown：生成包含各便签 Markdown 文件的 ZIP。
- 导出 JSON：生成可再次导入 MyNote 的结构化数据。
- 完整 ZIP 备份：包含便签、分组和账号所属图片，适合迁移或恢复。

导入不会读取 WPS 云端账号，也不会自动抓取第三方云便签。需要先从原服务导出或整理为受支持的文件格式。

## 图标和主屏幕快捷方式

- Windows Edge：打开网站，选择“设置及其他 → 应用 → 将此站点安装为应用”，即可获得独立窗口、桌面和开始菜单入口。
- 电脑浏览器会显示透明背景的 favicon 和应用图标。
- Android：使用 Chrome 打开网站，选择“添加到主屏幕”。
- iPhone、iPad：使用 Safari 打开网站，点击“分享 → 添加到主屏幕”。

项目包含浏览器 favicon、Web App Manifest、Apple Touch Icon 和 Windows 磁贴图标。桌面图标使用透明背景；Android maskable 图标和 Apple Touch Icon 使用白色底板。更新后仍显示旧图标时，请关闭旧标签页并清除该站点的缓存；已经安装的应用或主屏幕快捷方式需要删除后重新添加。

MyNote 提供主屏幕图标和响应式网页，但当前不提供断网编辑、后台同步或完整 PWA 离线能力。

## 数据目录

所有持久数据默认保存在项目的 `instance` 文件夹：

| 路径 | 内容 |
| --- | --- |
| `instance/mynote.sqlite3` | 账号、分组、便签、登录失败记录和附件记录 |
| `instance/uploads/` | 用户上传的便签图片 |
| `instance/.secret_key` | 登录会话签名密钥 |

请同时备份以上三部分。不要删除或每次启动都重新生成 `.secret_key`，否则现有登录会话会立即失效。

`instance`、数据库文件、本地环境和导出 ZIP 已被 `.gitignore` 与 `.dockerignore` 排除，不会正常进入 Git 仓库或 Docker 镜像。

## 备份与恢复

推荐定期在网站中下载“完整 ZIP 备份”，并将备份保存到另一台设备。

恢复到新的 MyNote：

1. 启动新的 MyNote 并注册接收数据的账号。
2. 打开“账号与数据”。
3. 点击“导入文件”，选择完整 ZIP 备份。
4. 导入完成后检查分组、便签和图片。

也可以完整复制 `instance` 文件夹。直接复制前必须先停止 MyNote，避免 SQLite WAL 中仍有未合并的数据：

```powershell
docker compose stop
# 复制整个 instance 文件夹
docker compose start
```

不要只复制运行中的 `instance/mynote.sqlite3` 主文件。完整 ZIP 备份包含私人便签和图片，应当像密码文件一样妥善保管。

## 更新

更新前建议先下载完整 ZIP 备份，或在停止服务后复制整个 `instance` 文件夹。

### Docker Desktop

更新项目文件后运行：

```powershell
docker compose up -d --build
docker compose ps
```

### 群晖

1. 用新版本替换程序文件，但保留原来的 `instance` 文件夹。
2. 在 Container Manager 的项目页面重新构建。
3. 构建完成后启动项目并检查容器状态与日志。

数据库会在应用启动时自动完成兼容性迁移。不要在升级时覆盖或删除 `instance`。

## Docker 构建镜像源

项目的 Dockerfile 默认只在安装 Python 依赖时使用腾讯 PyPI 镜像：

```text
https://mirrors.cloud.tencent.com/pypi/simple
```

该设置只影响 MyNote 镜像的构建，不会修改 Docker Desktop、宿主机 pip 或其他项目的配置。

如需临时改用官方 PyPI：

```powershell
docker compose build --build-arg PIP_INDEX_URL=https://pypi.org/simple
docker compose up -d
```

Python 基础镜像仍从 Docker 镜像仓库拉取，PyPI 镜像不会影响基础镜像下载速度。

## 配置

### 修改端口

默认端口映射位于 `docker-compose.yml`：

```yaml
ports:
  - "5055:5000"
```

只修改左侧的宿主机端口。例如改为 `8080:5000` 后，通过 `http://设备IP:8080` 访问。

### 修改数据位置

默认映射为：

```yaml
volumes:
  - ./instance:/app/instance
```

如需使用固定目录，只修改冒号左侧路径，并确保 Docker 对该目录具有读写权限。修改前请停止服务并完整迁移原 `instance` 内容。

## 登录保护

MyNote 默认采用以下策略：

- 登录失败计数按实际连接 IP 记录在 SQLite 中。
- 同一 IP 在 15 分钟窗口内连续失败 3 次后，返回 HTTP `429` 并暂停登录 15 分钟。
- 封禁期间即使密码正确也不能从该 IP 登录。
- 成功登录会清除该 IP 的失败记录。
- 过期封禁自动解除，旧记录会自动清理。
- 不直接信任客户端传入的 `X-Forwarded-For`，避免攻击者伪造 IP 绕过限制。

该功能是防爆破措施，不是完整的入侵防护系统。攻击者仍可能轮换 IP；同一家庭或代理出口下的用户也可能因为他人连续输错而一起被暂时限制。

如果 MyNote 位于反向代理后面，应用默认可能只看到代理 IP。不要直接信任来自公网的转发头；应当只在明确知道代理层级和来源的情况下配置可信代理，并在代理层同时启用 HTTPS 和请求频率限制。

## 安全边界和建议

现有防护包括密码哈希、CSRF、用户数据隔离、参数化 SQL、富文本清洗、图片内容签名检查、附件权限校验、ZIP 路径检查和解压总量限制。

仍需注意：

1. **首次管理员注册**：第一个注册者会成为管理员。新安装必须先在可信网络中由设备所有者完成首次注册。
2. **开放注册**：家庭成员注册完成后建议由管理员关闭开放注册。
3. **HTTP 局域网访问**：普通 HTTP 无法防止同一不可信网络中的窃听。不要在公共 Wi-Fi 上使用；公网访问必须配置 HTTPS。
4. **IP 封禁局限**：它不能替代反向代理、防火墙或 Fail2ban，也可能对共享 IP 造成短暂误伤。
5. **缺少 2FA 和审计日志**：当前没有双因素认证、登录历史或安全事件告警，不适合高敏感或合规场景。
6. **备份敏感性**：JSON 和完整 ZIP 可能包含全部私人内容，下载后需要加密保存并控制访问权限。
7. **依赖更新**：应定期更新 Flask、Werkzeug、Bleach、Markdown、Waitress 和基础镜像，并重新运行测试。

MyNote 默认面向可信家庭局域网，不建议直接把 `5055` 端口映射到公网。

## 常见问题

### 页面打不开

```powershell
docker compose ps
docker compose logs --tail 100 mynote
```

确认容器处于运行或健康状态，并检查 `5055` 是否被其他程序占用。手机访问时不能使用 `127.0.0.1`，必须使用运行 MyNote 设备的局域网 IP。

### 更新后仍显示旧界面或旧图标

确认已经重新构建镜像，而不只是重新启动旧容器。然后强制刷新浏览器，或关闭标签页后重新打开。主屏幕图标需要删除旧快捷方式再重新添加。

### 关闭手机浏览器后要求重新登录

确认运行的是包含 30 天持久会话功能的最新版本，并保留 `instance/.secret_key`。如果旧 Cookie 已经丢失，需要在升级后重新登录一次。

### 提示 IP 已暂时限制登录

等待页面提示的时间后重新登录。不要反复尝试，否则无法帮助恢复。默认封禁会在 15 分钟后自动解除；同一 IP 下的其他账号在这段时间也无法登录。

### SQLite 报锁定或 I/O 错误

确认 `instance` 位于本机磁盘或群晖本机卷中，而不是 SMB、NFS、网盘同步目录或不支持文件锁的存储。

### Docker 构建仍然很慢

腾讯 PyPI 镜像只加速 Python 依赖。第一次构建还需要下载 Python 基础镜像；这部分速度由 Docker 镜像仓库和网络环境决定。

## 开发与测试

环境要求：Python 3.12+、uv。

```powershell
uv sync
uv run pytest
uv run waitress-serve --listen=0.0.0.0:5000 wsgi:application
```

主要目录：

```text
mynote/           Flask 应用、数据库和 API
templates/        Jinja 页面模板
static/           JavaScript、CSS、图标和 Manifest
tests/            Flask 测试
instance/         本地数据（不进入 Git 和镜像）
Dockerfile        容器镜像配置
docker-compose.yml
```

提交代码前建议运行：

```powershell
uv run pytest
git diff --check
```

## 当前不包含

- 日历和定时提醒。
- 共享便签或多人实时协作。
- WPS 云端数据自动抓取。
- 公网云同步服务。
- 断网编辑和后台离线同步。
- 双因素认证和登录审计日志。
- 原生 Android、iOS、Windows 或 macOS 应用。

## 开源许可

MyNote 使用 [MIT License](LICENSE)。发布自己的版本前，请确认没有提交 `instance`、数据库、上传文件、会话密钥、日志、备份或真实账号信息。
