# AI Data MCP

面向 AI Agent 和开发者的本地数据库 MCP，支持 MySQL、Redis、MongoDB，共 18 个工具。

[English](README.md) · [配置说明](docs/configuration.md) · [工具契约](docs/tool-contracts.md) · [安全边界](SECURITY.md)

当前版本为 **公开 Alpha**，定位本地单用户。所有连接默认只读；非生产写入必须在本地配置中显式开启；生产环境始终禁止写入。

| 数据源 | 查询与检查 | 显式开启的非生产写入 |
|---|---|---|
| MySQL | 连接、表/视图、字段/索引、参数化 SQL | 单条 DML/DDL、托管 DML 事务 |
| Redis | 连接、SCAN、白名单只读命令 | 白名单修改命令 |
| MongoDB | 连接、集合、查询/计数/聚合 | 插入、带条件更新和删除 |

## 无凭据体验

需要 Node.js 22.12+；CI 覆盖 Node 22/24。发布检查和打包另需 Python 3.10+。

```sh
git clone https://github.com/ResetFull/ai-data-mcp.git
cd ai-data-mcp
npm ci --ignore-scripts
npm run build
npm run demo
```

演示使用临时合成配置，实际启动 STDIO MCP、发现 18 个工具并验证写保护。
它不读取现有配置，不连接数据库，也不需要模型 API Key。

## 配置数据库

```sh
npm run config:init
# 在源码目录外编辑 ~/.config/data-mcp/connections.json 和 secrets.json。
npm run config:validate
npm run smoke:configured
```

初始化只创建缺失文件，已有文件完整保留。后两步只检查配置和工具调度，不证明数据库连通或授权正确。
连接按 mysql、redis、mongo 分组，凭据单独存储。详见[全部字段与路径覆盖方式](docs/configuration.md)。

environment 只能是 prod/staging/test/dev/local。write_enabled 默认 false，只有非生产连接显式设为 true 才能写入。
生产账号仍须在数据库层授予最小只读权限；环境标签由配置者负责，服务不能自动判断真实服务器用途。
修改配置后需要重启 Data MCP 进程。

查询结果会返回所选 AI 宿主，可能发送给其模型服务商。任意查询字段不会自动脱敏。
源码、客户端示例和公开 Issue 中都不应放真实密钥或业务查询结果。

## 标准 STDIO 接入

任意支持 STDIO 的 MCP 客户端均可启动：

```sh
node dist/index.js --transport=stdio
```

将客户端 command 设为 node，args 设为构建后 dist/index.js 的真实绝对路径及 --transport=stdio。
Windows JSON 路径使用正斜杠或转义反斜杠。[英文 README](README.md#connect-any-stdio-mcp-client) 给出完整示例。

## 可选共享 HTTP 与 Codex 插件

共享进程使用 npm run start:http，需要服务端和客户端都能读取 DATA_MCP_HTTP_TOKEN。
默认监听 127.0.0.1:17890；/mcp 必须鉴权；/health 只证明进程响应，不证明数据库可用。

Windows 在构建后可运行 npm run service:install，安装当前用户的 AI-Data-MCP 计划任务并生成/复用用户级 Token。
安装器发现端口被其他进程占用会拒绝安装。重启 Codex 以继承环境变量。先把 HTTP 服务配置并启动，再安装适配插件：

```sh
codex plugin marketplace add https://github.com/ResetFull/ai-data-mcp.git
codex plugin add data-mcp@ai-data-mcp
```

插件安装不会自动安装 Node 依赖、构建服务或注册守护进程。
原有 personal 插件使用相同 data-mcp 标识时，应先在宿主中明确管理旧安装再切换；本仓发布不修改旧插件。
标准 STDIO 入口可以独立使用。

Windows 使用 npm run service:start/status/stop/uninstall 对应的独立命令管理任务，例如 npm run service:status。
卸载保留外部配置和可能被其他安装共享的 Token。Linux/macOS 可自行管理 HTTP 进程，当前不提供 systemd/launchd 安装器。

## 写入与异常恢复

MySQL DDL 单次调用必须传 allow_ddl=true；无 WHERE 的 UPDATE/DELETE 必须传 allow_all=true。
MongoDB 空条件更新/删除同样需要 allow_all=true。这些参数不能绕过生产禁写或本地 write_enabled。
WHERE 存在不代表条件安全；DDL 可能隐式提交；事务原子性需要 InnoDB 等事务表。

写入超时或断线不能证明没有提交。WRITE_OUTCOME_UNKNOWN 要求先读回核对，再决定是否重试。
服务不自动重试写入，也没有持久化幂等记录。成功响应的文本与结构化数据合计限制为 100000 字节；
这个限制不代表数据库计算量或驱动峰值内存有同样上限。MySQL 仅限制并发握手，不限制活跃连接总数。

## 验证与发布

```sh
npm run check
npm run smoke
npm audit
python -B scripts/privacy_check.py
python -B scripts/publication_checks.py
python -B scripts/package_release.py
```

发布打包要求干净且已提交的工作区，重新构建后对白名单文件和最终 ZIP 做隐私扫描，生成 SHA256SUMS。
ZIP 含源码、构建产物、测试、示例和文档，不捆绑 npm 依赖。
CI 覆盖 Windows/Linux、Node 22/24，以及 Linux 中隔离的 MySQL 8.4、Redis 7.4、MongoDB 7.0。
业务端到端、macOS、集群/故障切换、自定义 CA 和 Windows 常驻任务安装等未验证范围见[验证说明](docs/validation.md)。

许可证为 Apache-2.0。参见 [LICENSE](LICENSE)、[NOTICE](NOTICE)、[依赖许可清单](docs/third-party.md)、[贡献说明](CONTRIBUTING.md) 和 [SECURITY](SECURITY.md)。
