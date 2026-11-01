---
name: dsh-api
description: 通过 HTTP 调用 DeepSeek Harness（dsh-api 接口）：提交任务、轮询状态、获取最终回复与完整对话记录、取消任务，以及使用 harness 的 agent 预设（标准工具集）完成实际工作。适用于其他 agent 或程序远程驱动本机 DeepSeek Harness。
---

# dsh-api — 调用 DeepSeek Harness 的 HTTP 接口

本技能指导**外部 agent（或任何程序）**如何通过 HTTP 调用本机 DeepSeek Harness：
提交一个任务（prompt），Harness 会启动一个完整配置的 agent（默认 `standard` 预设，
带文件读写、shell、子代理、goal 等全套工具）执行任务，任务完成后通过轮询取回
**最终回复（reply）**与**完整对话记录（transcript）**。

接口地址：`http://127.0.0.1:3080`（与 WebUI 同端口，默认仅监听本机回环地址）。

---

## 1. 鉴权

所有请求（除无鉴权部署外）都需要 API 密钥，两种传法任选其一：

- 请求头 `Authorization: Bearer <apiKey>`
- 请求头 `X-API-Key: <apiKey>`

默认密钥为 `dsh-api-demo-key`；生产使用请通过环境变量 `DSH_API_KEY` 或修改
`~/.dsh/profiles/web/cordis.patch.yml` 中 `dsh-api` 行的 `apiKey` 配置。

```bash
KEY="dsh-api-demo-key"
```

## 2. 健康检查

```
GET /api/v1/health
```

```bash
curl -s http://127.0.0.1:3080/api/v1/health -H "X-API-Key: $KEY"
# => {"ok":true,"data":{"service":"dsh-api","version":"1.0.0","time":...}}
```

## 3. 提交任务（核心）

```
POST /api/v1/tasks
Content-Type: application/json
```

请求体（JSON）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | ✅ | 给 agent 的任务指令（模型语言由你自己决定，中文可用） |
| `preset` | string | | agent 预设 id（默认 `standard`，含完整工具集） |
| `cwd` | string | | 任务工作目录（绝对路径；默认 `process.cwd()`，即 harness 启动目录） |
| `provider` / `model` | string | | 覆盖模型路由（默认使用 harness 当前默认模型） |
| `maxTokens` | number | | 单次模型输出上限 |
| `reasoningEffort` | string | | 推理力度（由 provider/adapter 解释，如 `high`） |
| `system` | string | | 附加系统指令（以 `instructions` 上下文注入）。**仅会话首个任务生效**；续接任务带 `system` 会被忽略（避免上下文累积重复指令） |
| `timeoutMs` | number | | 本任务预算（默认 20 分钟，上限 2 小时） |
| `sessionId` | string | | **续接**：复用之前 API 创建的会话继续对话 |
| `wait` | boolean | | `true` 时同步等待任务完成再返回（默认 `false` 异步+轮询） |
| `waitTimeoutMs` | number | | `wait` 模式下的最大等待时间 |

**方式 A — 异步提交 + 轮询（推荐）：**

```bash
curl -s -X POST http://127.0.0.1:3080/api/v1/tasks \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"请用中文写一首五言绝句","preset":"standard"}'
# => {"ok":true,"data":{"taskId":"task-...","sessionId":"api-...","status":"running"}}
```

得到 `taskId` 后轮询（见第 4 节）。

**方式 B — 同步等待：**

```bash
curl -s -X POST http://127.0.0.1:3080/api/v1/tasks \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"1+1=?","wait":true,"waitTimeoutMs":120000}'
```

任务完成返回 `200` 与完整结果；超时返回 `202` 与 `taskId`，改用轮询。

**Python 示例（完整流程）：**

```python
import json, time, urllib.request

BASE = "http://127.0.0.1:3080/api/v1"
KEY = "dsh-api-demo-key"

def call(path, method="GET", body=None, timeout=30):
    req = urllib.request.Request(
        f"{BASE}{path}", method=method,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body else None)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)

task = call("/tasks", "POST", {
    "prompt": "请在工作区创建一个 hello.txt，内容为 'hi from dsh'，然后告诉我路径",
    "preset": "standard", "wait": True, "waitTimeoutMs": 180000,
})["data"]
print("status:", task["status"])
print("reply :", task["reply"])
print("tools :", task["toolCalls"])
```

## 4. 获取结果（轮询）

```
GET /api/v1/tasks/:taskId
```

```bash
curl -s http://127.0.0.1:3080/api/v1/tasks/task-xxxx -H "X-API-Key: $KEY"
```

返回 `data` 字段：

| 字段 | 说明 |
| --- | --- |
| `taskId` / `sessionId` | 任务与会话标识（`sessionId` 可用于续接） |
| `status` | `running` / `completed` / `failed` / `timeout` / `canceled` / `max-tokens`（输出撞上限被截断，`reply` 保留部分文本） |
| `reply` | **最终回复文本**（最后一条 assistant 消息） |
| `transcript` | 完整对话记录 `[{role:"user"|"assistant", text}]` |
| `toolCalls` | 工具调用列表 `[{name, callId}]`（如 `write`、`bash`） |
| `turnEnd` | 轮次结束原因（`completed` / `error` / `aborted` …） |
| `error` | 失败详情 `{code, message}` |
| `preset` / `provider` / `model` | 实际使用的预设与模型 |
| `createdAt` / `startedAt` / `finishedAt` | 时间戳 |

轮询建议间隔 3–10 秒，直到 `status != "running"`。

## 5. 任务列表与取消

```
GET    /api/v1/tasks            # 最近 50 个任务
DELETE /api/v1/tasks/:taskId    # 取消任务并释放 agent
```

```bash
curl -s -X DELETE http://127.0.0.1:3080/api/v1/tasks/task-xxxx -H "X-API-Key: $KEY"
# => {"ok":true,"data":{"taskId":"task-xxxx","status":"cancel-requested"}}
```

取消后任务状态变为 `canceled`。任务结束后 agent 默认保留 10 分钟（可续接、可在
WebUI 中查看），之后自动释放。

## 6. 多轮对话（续接同一会话）

把上一轮返回的 `sessionId` 传回 `POST /api/v1/tasks`，即可在**同一会话**中继续，
agent 保留全部上下文（记忆、已创建的文件等）：

```bash
curl -s -X POST http://127.0.0.1:3080/api/v1/tasks \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"继续：把上一步的文件内容改成大写","sessionId":"api-xxxx","wait":true}'
```

注意事项：
- 只能续接**本 API 创建**的会话；预设（`preset`）不能中途更换（返回 409）。
- 续接时 agent 若已被释放（超过保留窗口），会自动从磁盘恢复（resume）。

## 7. 让 harness 干真正的活（工具与预设）

`standard` 预设的 agent 拥有完整能力：文件读写（`write`/`read`/`edit`）、命令执行
（`bash`/`pwsh`）、子代理（`subagent`）、任务清单（`todo`）、网页搜索（`web`）等。
在 prompt 中直接、明确地提出要求即可，例如：

- 「读取 `C:\...\src\main.ts`，重构其中的 `parse()` 函数，并用工具运行测试验证」
- 「在工作区初始化一个 git 仓库，提交一个 README，运行 `git log` 确认」
- 「搜索 2026 年 DSH 的最新发布信息，汇总成 5 条要点」

其他可用预设：`minimal`（无工具，纯对话）、`code`（偏编码）、`cordis`
（harness 自身的 Cordis 插件开发能力）。错误/不存在的预设返回 `400 bad_preset`。

## 8. 错误码速查

| HTTP | code | 含义与处理 |
| --- | --- | --- |
| 400 | `missing_prompt` | 未提供 `prompt` |
| 400 | `bad_preset` / `bad_cwd` | 预设不存在 / cwd 非绝对路径 |
| 401 | `unauthorized` | 密钥缺失或错误 |
| 404 | `unknown_task` / `unknown_session` | taskId 或 sessionId 不存在 |
| 405 | `method_not_allowed` | 方法不对 |
| 409 | `preset_conflict` | 续接时更换了预设 |
| 413 | `payload_too_large` / `prompt_too_long` | 请求体 / prompt 超限 |
| 429 | `busy` | 并发任务超过上限（默认 8） |
| 任务内 | `BLOCKED` | 轮次被策略拦停（`status=failed`，`turnEnd=blocked`） |
| 任务内 | `INTERRUPTED` | 轮次被崩溃恢复收尾打断（`status=failed`），请重跑任务 |
| 任务内 | `UNKNOWN_TURN_END` | 轮次以未知原因结束（`status=failed`） |
| 任务内 | `error: {code, message}` | agent 轮次失败（LLM 错误、工具失败等），见 `turnEnd` |

## 9. 运维须知

- **重启失效**：任务记录存于内存，harness 重启后需重新提交；已完成的会话记录持久化在
  `~/.dsh/sessions`，可在 WebUI 中查看。
- **修改配置**：编辑 `~/.dsh/profiles/web/cordis.patch.yml` 中 `dsh-api` 行的
  `config`（密钥、默认预设、超时、并发等），重启 `dsh web` 生效。
- **安全**：该接口等同本机 shell 权限（agent 可执行任意命令）。默认仅监听
  `127.0.0.1`；如对外暴露（`--host 0.0.0.0`），务必更换默认密钥。
- **接口不可用时**：检查 `GET /api/v1/health`；若 404，确认 harness 正在运行且
  `dsh-api` 行已加载（日志中应有 `dsh-api: routes mounted` 行）。

## 9.1 部署到其他 DeepSeek Harness 实例

分享包 `share/dsh-api/`（插件 + 本技能）可一键装到任意 web profile 的实例：

```powershell
cd share/dsh-api/plugin
powershell -ExecutionPolicy Bypass -File install.ps1 -ApiKey 你的密钥
```

- `-DshHome <路径>`：DSH 数据目录（默认 `$env:DSH_HOME` 或 `~/.dsh`）；
- `-Profile <name>`：目标 profile（默认 `web`，必须含 `webServer` 组件）；
- 脚本会复制插件包到 `profiles/<profile>/node_modules/dsh-api/` 并在
  `cordis.patch.yml` 注入插件行（已存在则跳过），原文件自动备份；
- 安装后**重启 `dsh web`**，用 `GET /api/v1/health` 验证；
- 卸载：`uninstall.ps1`（移除插件行与包目录，备份可回滚）。

## 10. 快速自检

```bash
KEY="dsh-api-demo-key"
curl -s http://127.0.0.1:3080/api/v1/health -H "X-API-Key: $KEY"   # ok
TASK=$(curl -s -X POST http://127.0.0.1:3080/api/v1/tasks \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"用一句话回答：7*8=?","wait":true,"waitTimeoutMs":120000}')
echo "$TASK"   # status=completed, reply="56"
```
