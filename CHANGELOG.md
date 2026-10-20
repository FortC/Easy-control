# Changelog

本项目所有显著变更均记录于此，格式遵循 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

暂无。

## [0.3.0] - 2026-10-20

首个可分发版本：全栈骨架 + 模拟器闭环 + Windows 安装包。

### Added

- **桌面工作台（Electron + React）**：总览、账号中心、内容工作台、任务与日历、结果与数据、异常处理、资料与素材、助手与模型 8 个页面；深色侧边栏 + 品牌标识；托盘常驻（关窗最小化）；「关于」面板与帮助菜单含发布人联系方式。
- **后台服务**：Fastify 管理 API（JWT 登录、工作空间隔离、全量业务路由）；pg-boss 持久调度与到期发放；模拟平台审核推进；抖音官方 API 内部执行器。
- **本地执行器（Runner）**：一次性配对码换设备凭据、30 秒心跳、长轮询领取、SQLite 收据库、不可逆提交前 COMMIT_INTENT 落盘、断网结果补报（服务端按 task+attempt 幂等去重）。
- **内容链路**：基于真实资料的平台草稿生成（内置 Mock 供应商 + OpenAI 兼容适配：智谱/DeepSeek/通义/Kimi/OpenAI）、事实引用、AI/商业声明、送审-审批（审批绑定内容哈希，修改即失效）、单次/周期排程。
- **平台连接器**：simulator（演示闭环）、redbook 实验适配器（固定上游 0.8.2，UNVERIFIED）、微博官方 CLI 白名单包装（UNVERIFIED）、抖音官方 API（UNVERIFIED）；错误码统一映射，验证码/会话失效自动转 NEEDS_HUMAN 并熔断账号外发。
- **运维与安全**：状态机强约束（非法迁移拒绝）、事务性 outbox、调度物化唯一键防重、凭据 AES-256-GCM 加密、密钥不进日志与模型上下文、异常登记与处理入口、模型费用计量。
- **发布工程**：Lucide 品牌图标（窗口/托盘/favicon，ISC 许可）、electron-builder NSIS 安装包配置、MIT 许可证、CHANGELOG。

### Verified

- 冒烟测试 24/24：注册 → 连号 → 生成 → 审批 → 排程 → 执行 → 已发布全链路；验证码场景转人工；审批失效；重复上报幂等。
- 单元测试 18/18：任务状态机全迁移表、任务信封校验、发布前检查。
- 真实进程链路：api + worker + runner 三进程实测 75 秒排程任务 SCHEDULED → … → PUBLISHED 并返回链接。

### Known Limitations

- 小红书 redbook / 微博 CLI / 抖音官方 API 三条真实通道代码就绪但未经真实凭据验证（UNVERIFIED），以平台 PoC 实测为准。
- 平台拦截时暂停转人工，不做绕过（反检测、验证码代解、账号轮换均不实现）。
