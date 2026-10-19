# XD Pool Claude Bridge

把本机已登录的 **WorkBuddy 桌面账号**里的模型额度，接进 **Claude Code** 和 **Claude 桌面 App**。

桥在本机监听一个 Anthropic Messages API（默认 `http://127.0.0.1:8327`），下游复用
[dsh-xdpool](https://github.com/XDTrees/dsh-xdpool) 的账号发现、凭据解密、账号轮换和
WorkBuddy 上游客户端。Claude 侧完全不需要改动，只是把 base URL 指向这个桥。

```
Claude Code / Claude 桌面 App
        │  Anthropic /v1/messages (SSE)
        ▼
   bridge.ts  ── anthropic.ts（请求映射）
              └─ stream.ts（OpenAI SSE → Anthropic 事件）
        │  OpenAI /v1/chat/completions
        ▼
   dsh-xdpool shim（账号池、429 冷却、失败换号）
        │
        ▼
   WorkBuddy 上游（国内 / 国际网关）
```

---

## 前置条件

| 需求 | 说明 |
| --- | --- |
| **Windows 10/11** | 脚本是 `.cmd` + PowerShell |
| **Node.js 24+** | 必须支持 `--experimental-transform-types`（依赖里的构造器参数属性不支持 strip-only 模式） |
| **WorkBuddy 桌面 App** | 已安装并**登录**；桥会读取它的本机凭据（只读，不解密以外的操作） |
| **Claude Code / Claude 桌面 App** | 按需，用哪端就装哪端 |

> 不需要安装 DSH 宿主，也不需要在 WorkBuddy 里做任何导出操作。
> 多账号 = 在 WorkBuddy 桌面 App 里换着登几个号，桥会自动发现并轮换。

---

## 快速开始

### 1. 启动桥

双击 **`start.cmd`**，保持窗口打开。首次启动会输出类似：

```
accounts: 1
catalog: 27 live model(s)
ready at http://127.0.0.1:8327 (token: xdpool-local)
```

### 2. 接入 Claude Code（命令行）

```bash
D:\free_api\xdpool-claude-bridge\claude-xdpool.cmd
```

或指定其它模型：

```bash
D:\free_api\xdpool-claude-bridge\claude-xdpool.cmd --model glm-5.3
```

这个脚本只在**它自己的进程**里设置 `ANTHROPIC_*` 环境变量，不会改动
`~/.claude/settings.json`，因此不影响你其它的 Claude Code 会话和项目。

### 3. 接入 Claude 桌面 App（可选）

> 桌面 App 的网关配置是**全局**的，切换需要**完全退出 App 再启动**。

1. 完全退出 Claude 桌面 App（托盘也要退出）。
2. 双击 **`desktop-xdpool.cmd`**：写入 XD Pool 网关配置 → 必要时启动桥 → 启动 App。
3. 想切回原来的 CC Switch / 其它网关：完全退出 App，双击 **`desktop-ccswitch.cmd`**。

每次切换都会在 `%LOCALAPPDATA%\Claude-3p\configLibrary\` 留下
`_meta.json.bak-时间戳` 备份，可手动还原。

---

## 可用模型

桥对外列出的模型是 WorkBuddy 账号实时返回的目录（`GET /v1/models`）。
但**账号类型决定权限**：`personal_free_user` 只对部分模型放行。

实测可用的常见 id：

| 模型 id | 说明 |
| --- | --- |
| `deepseek-v4.1-flash` | 默认，综合可用性最好 |
| `deepseek-v4.1-flash-sg` | 新加坡路由 |
| `glm-5.3` / `glm-5.2` | 智谱 |
| `kimi-k3` | Kimi |

- `deepseek-v4-pro` 可能显示在目录里但上游不可用（错误码 `11102`）。
- gpt / gemini 等模型对免费账号返回 `11158 model is not allowed for user type`。
- **不在目录里的模型 id 会自动回落到默认模型**，所以 Claude Code 传 `claude-sonnet-4-5`
  这类别名不会报错，而是走 `deepseek-v4.1-flash`。

换默认回落模型：在 `start.cmd` 里加 `set WB_MODEL=glm-5.3`，或启动前设环境变量。

---

## 配置项（环境变量）

在 `start.cmd` 中设置，或启动前在 shell 里 `set`。

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `WB_PORT` | `8327` | 桥监听端口（仅 127.0.0.1） |
| `WB_TOKEN` | `xdpool-local` | 本地访问令牌；同时接受 `x-api-key` 和 `Authorization: Bearer` |
| `WB_MODEL` | `deepseek-v4.1-flash` | 未知模型 id 的回落目标 |
| `WB_RESCAN_MS` | `300000` | 重新扫描账号的间隔（毫秒） |
| `WB_DEBUG_BODY` | 未设 | 设为 `1` 时把映射后的请求体写到 `bridge-debug.json`（调试用） |
| `WB_IDE_VERSION` | `5.5.6` | 聊天请求的 `X-IDE-Version`；WorkBuddy 升级后可改成实际版本 |
| `WB_DESKTOP_UA` | `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1` | 聊天请求的 `User-Agent` |

---

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/`、`/health`、`/healthz` | 健康检查：账号数、模型数、监听状态（无需鉴权） |
| `GET` | `/v1/models` | Anthropic 形状的模型列表 |
| `POST` | `/v1/messages` | 主接口，支持流式（`stream:true`）与非流式 |
| `POST` | `/v1/messages/count_tokens` | 粗略 token 估算 |
| `OPTIONS` | `*` | CORS 预检 |

`/claude-desktop` 前缀会被自动去掉，所以桌面 App 配置里带部署前缀也能用。

错误响应是 Anthropic 形状：`{"type":"error","error":{"type":"...","message":"..."}}`。

---

## 目录结构

```
xdpool-claude-bridge/
├── bridge.ts              # 入口：HTTP 服务、鉴权、上游转发、账号重扫
├── anthropic.ts           # Anthropic 请求 → OpenAI chat body（system 清洗、工具映射）
├── stream.ts              # OpenAI SSE → Anthropic SSE 事件流
├── package.json           # 声明 type: module
├── start.cmd              # 启动桥
├── claude-xdpool.cmd      # 用桥启动 Claude Code
├── desktop-xdpool.cmd     # 切换桌面 App 到桥并启动
├── desktop-ccswitch.cmd   # 把桌面 App 切回其它网关并启动
├── desktop-profile.ps1    # 桌面 App 网关配置的写入/切换逻辑
└── vendor/
    └── dsh-xdpool/
        ├── LICENSE        # 上游 MIT 协议
        └── src/           # 从 dsh-xdpool 复制的最小依赖集（21 个文件）
```

`vendor/dsh-xdpool/src` 是为了让本包可独立运行而复制的最小闭包，
来源为 [XDTrees/dsh-xdpool](https://github.com/XDTrees/dsh-xdpool)（MIT）。
只复制了账号发现、凭据解密、上游客户端和 shim 所需的文件，没有包含 UI 与自动化部分。

---

## 实现要点

### 1. 账号与凭据

- 只读扫描 WorkBuddy 桌面 App 的 auth 文件（Windows 下为
  `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info`）。
- 5.6.0 起凭据字段是 AES-256-GCM 加密的。桥通过运行桌面 App 自己的二进制
  （`ELECTRON_RUN_AS_NODE`）读取它自己的 at-rest 密钥来解密，不在代码里内置密钥。
- 发现到的账号持久化到 `~/.dsh/.xdpool/accounts.json`，重启不丢。

### 2. 协议翻译

- **system**：Anthropic 的 `system` 字符串/块 → 第一条 `role:"system"`；缺失时注入默认值
  （上游要求第一条必须是 system，否则返回 `11128`）。
- **工具**：`tools[].input_schema` → `function.parameters`；`tool_choice` 的
  `any` → `required`。工具名不截断。`tool_result` 转成 `role:"tool"` 消息，
  孤儿 `tool_result` 降级为普通用户文本，避免上游 400。
- **图片**：转为 OpenAI `image_url`（支持 base64 与 URL）。
- **思考块**：`thinking` / `redacted_thinking` 丢弃。
- **响应**：完整发出 `message_start → content_block_start/delta/stop → message_delta → message_stop`，
  工具参数以 `input_json_delta` 分片；`tool_calls` → `stop_reason:"tool_use"`。

### 3. 渠道校验（重要）

WorkBuddy 上游会拦截 "非官方客户端"。实测触发词是 Claude Code 系统提示里的签名句：

- `You are Claude Code, Anthropic's official CLI for Claude.`
- `x-anthropic-billing-header: ...`
- `You are a Claude agent, built on Anthropic's Claude Agent SDK.`

`anthropic.ts` 会先替换这些句子。若仍被拦（桌面 App 的系统提示更长，可能含新签名），
`bridge.ts` 会按三档自动降级重试：

1. 已清洗的原请求
2. 换成中性系统提示，保留工具
3. 中性系统提示 + 去掉工具

日志会打印最终生效的档位（`recovered with neutral-system`）。三档都失败时会写
`bridge-last-failure.json`（系统提示与工具名，不含凭据），便于补充清洗规则。

### 4. 客户端身份头（2026-10 起）

WorkBuddy 5.8.x 之后，网关还会校验聊天请求必须带一套 ACP 风格的头，否则同样返回 `11128`：

- `X-Agent-Intent: craft`、`X-Agent-Type: main`、`X-Agent-Purpose: conversation`
- `X-Conversation-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID`
- `X-Request-ID`、`x-codebuddy-request: 1`、`X-Private-Data: true`
- `traceparent`、`b3`、`X-B3-TraceId` / `X-B3-SpanId` / `X-B3-ParentSpanId` / `X-B3-Sampled`

`vendor/dsh-xdpool/src/upstream.ts` 的聊天请求已经补齐这些头。版本与 UA 可分别用
`WB_IDE_VERSION`、`WB_DESKTOP_UA` 覆盖；实测 `5.5.6` 和 `5.8.4` 两个版本都能通过。

---

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 启动报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | Node 版本过低，需 24+ 且带 `--experimental-transform-types` |
| `no WorkBuddy account found` | 在 WorkBuddy 桌面 App 里登录一次 |
| 请求报 `ENCRYPTED_CREDENTIAL` | 桌面 App 不在探测路径内，设 `WORKBUDDY_APP_EXECUTABLE` 为 exe 全路径后重启桥 |
| Claude Code 报 `Not logged in` | 没用 `claude-xdpool.cmd` 启动，或 `settings.json` 被其它工具接管 |
| 请求跑到了别的服务 | 检查 `~/.claude/settings.json` 是否被 CC Switch 等工具改写 |
| 上游 `11128` 持续出现 | 先看桥日志的降级档位；若三档全败，把 `bridge-last-failure.json` 发给维护者。WorkBuddy 刚升级后出现的 11128 通常是身份头问题：用 `WB_IDE_VERSION=<安装版本>` 重启桥再试 |
| 上游 `11102` | 该模型在当前账号不可用，换 `deepseek-v4.1-flash` |
| 上游 `11158` | 该模型对免费账号不开放 |

---

## 已知限制

- 上游 `reasoning_content` 未映射为 Anthropic thinking 块，界面上不显示思考过程。
- 桌面 App 若走到第三档（去掉工具），其工具调用能力会失效。
- token 计费基于上游返回值或字符估算，与官方统计可能有偏差。
- 桥必须常驻；关闭后 Claude Code 与桌面 App 都会断开。
- 仅绑定 `127.0.0.1`，不对外网开放。

---

## 免责声明

本项目通过复用本机已登录的桌面客户端凭据来调用模型，属于对第三方服务使用条款的灰色地带。
可能出现账号被风控、限流或封禁的风险，请自行评估并承担相应后果。
上游接口随时可能变更导致本项目失效。

## 许可

本桥接代码为独立实现。`vendor/dsh-xdpool` 部分遵循其原仓库的 MIT 协议
（见 `vendor/dsh-xdpool/LICENSE`）。
