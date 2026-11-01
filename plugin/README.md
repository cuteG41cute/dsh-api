# dsh-api

DeepSeek Harness 对外可调用接口（HTTP API）：其他 agent 可以通过 HTTP 向
DeepSeek Harness 提交任务（prompt），并在任务完成后取回最终回复与完整对话记录。

## 部署

1. 本包已装入 `~/.dsh/profiles/web/node_modules/dsh-api/`。
2. `~/.dsh/profiles/web/cordis.patch.yml` 已添加一行 `dsh-api` 插件。
3. 重启 `dsh web` 后接口即持久可用（不重启时，当前进程内可通过动态插件临时加载）。

## 配置（cordis.patch.yml 中 dsh-api 行的 config）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `prefix` | `/api/v1` | 路由前缀 |
| `apiKey` | 空（关闭鉴权） | 必填密钥；建议 `!!js process.env.DSH_API_KEY ?? '你的密钥'` |
| `defaultPreset` | roster 默认（standard） | 未指定时使用的 agent 预设 |
| `defaultCwd` | `process.cwd()` | 未指定时任务的工作目录 |
| `defaultTimeoutMs` | 1200000 | 单任务默认预算（20 分钟） |
| `maxTimeoutMs` | 7200000 | 任务预算硬上限（2 小时） |
| `retentionMs` | 600000 | 任务结束后 agent 保留窗口（10 分钟） |
| `taskTtlMs` | 86400000 | 已结束任务记录保留时长（24 小时，超时清理；≤0 禁用清理） |
| `maxConcurrent` | 8 | 并发任务上限 |
| `maxBodyBytes` | 2097152 | 请求体上限 |
| `maxPromptChars` | 500000 | prompt 长度上限 |

## 接口

- `GET /api/v1/health` — 健康检查
- `POST /api/v1/tasks` — 提交任务（`prompt` 必填；可选 `preset/cwd/model/provider/maxTokens/reasoningEffort/system/timeoutMs/sessionId/wait`；
  `system` 仅在会话**首个任务**生效，续接任务会忽略）
- `GET /api/v1/tasks` — 最近 50 条任务（最新在前）
- `GET /api/v1/tasks/:taskId` — 查询状态与结果（`reply` = 最终回复，`transcript` = 对话记录）
- `DELETE /api/v1/tasks/:taskId` — 取消任务并释放 agent

任务状态：`completed / failed / timeout / canceled / max-tokens`（`max-tokens` =
输出撞上限被截断，`reply` 保留已有部分文本；`turnEnd` 字段始终携带原始结束原因）。

鉴权：`Authorization: Bearer <key>` 或 `X-API-Key: <key>`。CORS 预检（OPTIONS）
先于鉴权应答，浏览器可直接调用。

详见技能文档 `skills/dsh-api/SKILL.md`（含 curl/Python 示例与完整字段说明）。
