# AI People

面向抖音、小红书与微博的 AI 运营工作台。Windows 桌面工作台 + 后台任务服务 + 本地执行器。

当前状态：**第一期可运行骨架**。三平台通过「模拟器通道」跑通完整闭环（生成 → 审核 → 排程 → 执行 → 结果回传 → 异常处理）；redbook / 微博 CLI / 抖音官方 API 连接器代码已就绪但未经真实凭据验证（标注 UNVERIFIED）。

- [当前建设方案](docs/construction-plan.zh-CN.md)：产品形态、平台适配、模型与知识库、授权、定时、执行恢复、结果、部署和实施安排。
- [前期研究记录](docs/feasibility-and-implementation-plan.zh-CN.md)：保留研究过程与来源，实施选择以当前建设方案为准。

平台路线：小红书 redbook 实验适配器（第三方）、微博官方 CLI、抖音官方 API。平台拦截时暂停并转人工，不做绕过。

## 快速开始（开发环境）

前置要求：Node.js ≥ 22.5（含 node:sqlite）、pnpm、Docker Desktop（国内网络拉取镜像可用 `docker pull docker.m.daocloud.io/library/postgres:16-alpine` 后 `docker tag` 成 `postgres:16-alpine`）。

```bash
pnpm install            # 安装依赖（redbook 的 postinstall 钩子默认拦截，符合方案要求）
pnpm db:up              # 启动 PostgreSQL（docker compose，端口 5433）
pnpm db:migrate         # 建表
pnpm db:seed            # 演示数据：admin@aipeople.dev / admin123456
pnpm dev                # 同时启动 api(8787) + worker + runner
```

再开一个终端启动桌面工作台（开发模式，需先 `pnpm --filter @aipeople/desktop install` 已随根安装完成）：

```bash
pnpm dev:desktop        # Vite(5173) + Electron
```

登录 `admin@aipeople.dev / admin123456`，即可看到：3 个模拟平台账号、3 份真实资料、Mock 模型供应商。

### 第一个发布闭环（约 2 分钟）

1. **总览** → 「生成配对码」→ 复制命令：如果 `pnpm dev` 已含 runner，先删 `.local/runner` 重新配对，或直接用下面命令在另一台（本机亦可）设备执行：
   ```bash
   pnpm dev:runner -- --pair <配对码>
   ```
2. **内容工作台** → 输入目标（如「根据产品资料准备一篇种草笔记」）→ 勾选模拟账号 → 生成草稿
3. 查看引用与 AI 声明 → **送审** → **批准**（审批绑定内容哈希，改内容即失效）
4. 选择「单次发布」时间（如 1 分钟后）→ **创建排程**
5. **任务与日历** 观察状态：已排程 → 等待执行设备 → 执行中 → 已提交 → 平台审核中 → **已发布**
6. **结果与数据** 看回执、链接与模拟指标；**异常处理** 看是否有需人工的事项

### 冒烟测试

```bash
pnpm smoke              # 24 项断言：完整闭环 + 审批失效 + 验证码转人工 + 账号暂停 + 幂等重报
pnpm test               # 状态机 / 信封 / 发布前检查单测（vitest）
```

另有 `npx tsx scripts/live-check.ts`：在真实进程（api+worker+runner 运行中）创建 75 秒后排程的任务并轮询到 PUBLISHED。

## 代码结构

```
apps/desktop/                 Electron + React 工作台（8 页面）
apps/api/                     Fastify 管理服务（账号/内容/审批/排程/任务/结果/异常）
apps/worker/                  pg-boss 调度、到期发放、模拟平台审核、抖音内部执行器
apps/runner/                  本地执行器：配对、心跳、领取、SQLite 收据、COMMIT_INTENT
packages/contracts/           状态机、任务信封、错误码、适配器接口（纯类型 + zod）
packages/orchestration/       调度物化、发布前检查、领取、结果入账、对账（api/worker 共用）
packages/policy/              四层授权与发布前检查（纯函数）
packages/knowledge/           资料检索与引用
packages/model-gateway/       Mock + OpenAI 兼容供应商适配、费用计量
packages/connectors/simulator 模拟器通道（演示与测试）
packages/connectors/redbook/  小红书第三方适配器（固定 @lucasygu/redbook 0.8.2，UNVERIFIED）
packages/connectors/weibo/    微博官方 CLI 白名单包装（UNVERIFIED，需实测命令目录）
packages/connectors/douyin/   抖音官方 API（UNVERIFIED，需应用获批）
packages/server-kit/          环境变量、连接池、口令/凭据加密
infra/db/migrations/          PostgreSQL 迁移（纯 SQL）
scripts/                      seed / smoke / live-check
```

## 关键机制（对齐建设方案）

- **状态机**：`SCHEDULED → PREFLIGHT → WAITING_RUNNER → RUNNING → SUBMITTED → UNDER_REVIEW → PUBLISHED`，异常分支 `NEEDS_HUMAN / UNKNOWN / FAILED / MISSED / CANCELLED / REJECTED`；非法迁移直接拒绝（单测覆盖）。
- **审批绑定**：审批记录内容哈希 + 账号 + 动作 + 有效期；审批后修改内容，哈希不一致即拒绝发布（冒烟已验证）。
- **调度物化**：`schedule_id + occurrence_at + account_id + action` 唯一键防重，停机恢复自动补齐；单次排程接口同步建任务 + outbox 精确投递，Worker 扫描兜底。
- **提交边界**：Runner 在不可逆提交前落盘 `COMMIT_INTENT`；适配器异常退出按 UNKNOWN 处理，绝不自动重发；退出码 0 但无回执 ID 也标记未确认。
- **幂等**：结果按 `task+attempt` 去重（断网重报安全）；事件按 dedupe_key 去重。
- **账号熔断**：验证码 / 会话失效 → 任务 NEEDS_HUMAN + 账号暂停外发 + 异常登记（冒烟已验证）。
- **凭据**：小红书 Cookie 加密存服务端（回退路径），Runner 优先读本地 `vault/{accountId}.json`；密钥不进日志 / 任务 JSON / 模型上下文。
- **工作空间隔离**：所有查询带 workspace_id；Runner 设备令牌哈希存储、可撤销。

## 平台通道状态

| 通道 | 状态 | 说明 |
|---|---|---|
| simulator | ✅ 可用 | 演示闭环，不连真实平台 |
| redbook | ⚠️ UNVERIFIED | 代码就绪（进程内 XhsClient：上传→建笔记→note_id 回读，错误码映射齐全）；需真实会话验证。无平台级 AIGC 声明参数 → strict 策略下转人工 |
| weibo_cli | ⚠️ UNVERIFIED | 命令白名单包装（doctor / commands list / post --ai）；需安装官方 CLI 并实测命令目录 |
| douyin_api | ⚠️ UNVERIFIED | OAuth + 发布客户端骨架；需开发者应用获批后按当时文档补齐上传字段 |

## 环境变量（.env，参考 .env.example）

| 变量 | 默认 | 说明 |
|---|---|---|
| DATABASE_URL | postgres://aipeople:aipeople_dev@localhost:5433/aipeople | PostgreSQL 连接串 |
| API_PORT | 8787 | 后台 API 端口 |
| JWT_SECRET | dev-secret-change-me | 登录令牌签名（生产必须换强随机值） |
| RUNNER_BACKEND_URL | http://localhost:8787 | Runner 连接的后台地址 |
| DATA_DIR | .local | 本地数据（素材、Runner 库） |
| DOUYIN_CLIENT_KEY/SECRET | — | 抖音应用凭据（获批后配置） |

## 已知边界（第一期骨架）

- 真实平台发布未经实测；redbook/weibo/douyin 连接器的字段映射以 PoC 为准
- 微博多账号 CLI 隔离未验证（方案 §4.4：MVP 每 Runner 单微博会话）
- 素材文件路径当前按同机开发设计（API 与 Runner 同机）；跨机部署需改签名下载 URL
- Electron 安装包打包配置未做签名；托盘图标为占位
- 行级安全（RLS）未启用，隔离在仓储层强制；上线前按方案 §11 补数据层约束
