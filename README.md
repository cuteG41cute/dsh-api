# dsh-api — DeepSeek Harness 对外 HTTP 接口（插件 + Skill 联合体）

让**其他 agent 或程序**通过 HTTP 调用 DeepSeek Harness：提交任务（prompt）、轮询状态、
取回最终回复（`reply`）与完整对话记录（`transcript`）、取消任务、同一会话多轮续接。
任务由 harness 端完整配置的 agent 执行（默认 `standard` 预设：文件读写、shell、
子代理、goal 等全套工具）。

本包 = **插件**（部署到 DeepSeek Harness 端）+ **Skill**（供其他 agent 阅读学习）。

## 包结构

```
dsh-api/
├── README.md            ← 本文件
├── plugin/              ← 部署到 DSH 端（Cordis 插件）
│   ├── package.json
│   ├── lib/index.js     插件入口（配置归一化）
│   ├── lib/core.js      核心实现（路由、任务驱动、结果提取；零依赖纯 JS）
│   ├── install.ps1      一键安装（复制包 + 注入 cordis.patch.yml 插件行）
│   ├── uninstall.ps1    卸载（移除插件行 + 包目录，均可回滚）
│   └── README.md        插件级说明（配置项表）
└── skill/
    └── SKILL.md         ← 给其他 agent 学习的技能文档
```

## 快速开始（部署）

```powershell
cd plugin
powershell -ExecutionPolicy Bypass -File install.ps1 -ApiKey 你的密钥
```

脚本会：

1. 定位 DSH 数据目录（`-DshHome`，默认 `$env:DSH_HOME` 或 `~/.dsh`）与 profile（默认 `web`）；
2. 把插件包复制到 `profiles/web/node_modules/dsh-api/`；
3. 在 `profiles/web/cordis.patch.yml` 注入 `dsh-api` 插件行（已存在则跳过）；
4. 原文件自动备份（`.cordis.patch.yml.bak-<时间戳>`、`node_modules/.dsh-api-backup-<时间戳>`）。

然后**重启 `dsh web`**（关闭并重新启动 DeepSeek Harness），验证：

```bash
curl http://127.0.0.1:3080/api/v1/health -H "X-API-Key: 你的密钥"
# => {"ok":true,"data":{"service":"dsh-api","version":"1.0.0","time":...}}
```

> 密钥未传时默认 `dsh-api-demo-key`；最终配置为
> `!!js process.env.DSH_API_KEY ?? '<key>'`——设置环境变量 `DSH_API_KEY` 可覆盖。
> 监听默认仅限本机回环（`127.0.0.1:3080`）；对外暴露前务必更换密钥。

卸载：`uninstall.ps1 -ApiKey ...` 不需要；直接 `uninstall.ps1` 即可（会先备份再移除）。

## 接口一览

| 端点 | 功能 |
| --- | --- |
| `GET /api/v1/health` | 健康检查 |
| `POST /api/v1/tasks` | 提交任务（`prompt` 必填；支持 `preset/cwd/model/provider/maxTokens/system/timeoutMs/sessionId/wait`） |
| `GET /api/v1/tasks` | 最近任务列表 |
| `GET /api/v1/tasks/:taskId` | 轮询状态，取回 `reply`、`transcript`、`toolCalls` 等 |
| `DELETE /api/v1/tasks/:taskId` | 取消任务并释放 agent |

鉴权：`X-API-Key: <key>` 或 `Authorization: Bearer <key>`。

完整字段说明、curl/Python 示例、多轮续接、错误码速查：见 `skill/SKILL.md`。

## 兼容性

- 要求目标实例为 **web profile**（依赖 harness 的 `webServer` 服务）与 agent 预设系统；
- 插件为纯 JS、零运行时依赖，不修改 harness 源码；
- 任务记录存于内存，harness 重启后需重新提交（会话本身持久化在 `~/.dsh/sessions`）。

## 版本

v1.0 — 对应本机已验证的部署（含 firstSeq 修复、defaultCwd、wait 同步模式、
多轮续接、取消、并发上限、鉴权）。
