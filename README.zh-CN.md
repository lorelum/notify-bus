<p align="center">
  <h1 align="center">notify-bus</h1>
  <p align="center">可自部署的多渠道通知总线。GitHub webhook 进，飞书（及更多渠道）出。</p>
  <p align="center">
    <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue"></a>
    <a href="https://github.com/lorelum/notify-bus"><img alt="Status" src="https://img.shields.io/badge/status-early%20development-orange"></a>
    <a href="./CONTRIBUTING.md"><img alt="Contributing" src="https://img.shields.io/badge/contributions-welcome-brightgreen"></a>
  </p>
  <p align="center">
    <a href="./README.md">English</a> ·
    <a href="./README.zh-CN.md">简体中文</a>
  </p>
</p>

---

> ⚠️ **notify-bus 处于早期开发阶段。** 脚手架已就位，核心管道正按里程碑逐步构建。点 Star 跟进，或阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) / [Discussions](https://github.com/lorelum/notify-bus/discussions) 参与。

## 问题在哪

团队在 GitHub 上协作，日常沟通用飞书。每次 push、PR、issue、release、star、fork —— 你都希望群里能及时收到提醒。现有方案要么是死板的 GitHub Action，要么是纯命令行，要么是不让你掌控数据和路由规则的 SaaS。没有一个能在一个自部署的盒子里同时给你 **可配置管道** *和* **可视化管理后台**。

## notify-bus 怎么做

```
[GitHub] ──webhook──▶ [Bun + Elysia 服务]
                          │
                          ▼
                    [管道：Filter → Enricher → Template → ...]
                          │
                          ▼
                    [Dispatcher] ──路由匹配──▶ [渠道适配器] ──▶ [飞书 API]
                                                    ▲
                                                    │  ChannelAdapter 接口
                                                    │  （今天飞书；下一步 Slack / 钉钉 / 企业微信 / Discord）
```

- **Webhook 进，通知出。** 用原始 body 校验 GitHub 的 HMAC-SHA256 签名，解析事件，跑过可配置的中间件管道，渲染模板，分发。
- **天生多渠道，不是事后补的。** 新渠道只需实现 `ChannelAdapter` 接口。飞书是第一个适配器；路由和配置层与渠道无关。
- **改配置不用重新部署。** 内置管理后台（React + Vite + Tailwind）通过 REST API 编辑路由、渠道、模板 —— 底层是 `bun:sqlite`。调规则不用再走 YAML 往返。
- **一个镜像，一个进程。** 单个 Bun 进程同时提供 API *和* 构建好的前端。一个 Docker 容器，一个数据卷。

## 5 分钟体验

*(管道在建 —— 以下命令展示的是目标 UX。)*

```bash
# 本地运行
bun install
cp .env.example .env       # 设置 GITHUB_WEBHOOK_SECRET
bun run dev                # 服务在 :3000，前端在 :5173（Vite 代理）

# 或用 Docker 自部署
docker compose up -d       # API + 构建好的前端都在 :3000
```

然后把 GitHub webhook 指向 `https://your-host/webhook`，在管理后台加一个飞书自定义机器人 webhook 作为渠道，再加一条路由。搞定。

## 跟别人有什么不同

| | GitHub Action / 裸 webhook | SaaS 通知器 | **notify-bus** |
|---|---|---|---|
| **自部署 / 数据自主** | ✅ | ❌ | ✅ |
| **可配置管道** | ❌（改规则要改代码） | 部分 | ✅ Filter / Enricher / Template |
| **可视化管理后台** | ❌ | ✅ | ✅ |
| **多渠道** | 每个渠道手搓 | 按套餐限渠道 | ✅ `ChannelAdapter` 接口 |
| **按事件类型配模板** | 写死 | 受限 | ✅ Handlebars，按事件类型 |
| **License** | 不定 | 闭源 | ✅ MIT |

## 架构概览

```
┌────────────────────────────────────────────────────────────┐
│  GitHub ──POST /webhook──▶  Bun + Elysia 服务              │
│                              │                              │
│              ┌───────────────┴───────────────┐              │
│              ▼                               ▼              │
│   签名校验（原始 body）              EventMessage 解析       │
│              │                               │              │
│              └───────────────┬───────────────┘              │
│                              ▼                              │
│                   管道（中间件链）                           │
│                   Filter → Enricher → Template              │
│                              │                              │
│                              ▼                              │
│                  Dispatcher（路由匹配）                      │
│                              │                              │
│              ┌───────────────┼───────────────┐              │
│              ▼               ▼               ▼              │
│            飞书            (Slack)         (钉钉)           │
│           适配器           适配器 stub      适配器 stub       │
│                                                              │
│   管理后台 (React) ──/api/*──▶ 配置 (bun:sqlite + YAML)      │
└────────────────────────────────────────────────────────────┘
```

运行时合并两个配置源：
- **YAML**（`config.yaml`）—— 种子/引导配置，人写友好，支持热更新。
- **SQLite**（`data.db`）—— 路由、渠道、模板、日志的真相源；通过管理后台 / REST API 编辑。

## 路线图

在公开环境下按里程碑推进。每个里程碑 = 一个 issue + 一个 PR。

- **M1** —— 核心 webhook 接收 + GitHub 签名校验 + 飞书适配器（含签名）+ 兜底路由。纯 YAML，无前端。
- **M2** —— 中间件管道：Filter、Enricher、Template（Handlebars）。顺序与启停可配。
- **M3** —— `bun:sqlite` 持久化（routes/channels/templates/logs）+ REST API（CRUD）+ Config Manager（YAML↔DB 合并、热更新）。
- **M4** —— 前端骨架 + 路由管理页（Eden treaty 打通）。
- **M5** —— 渠道管理页（含连接测试）+ 模板编辑页（Monaco + 实时预览）。
- **M6** —— 日志页 + 测试发送（`POST /api/test`）。
- **M7** —— 集成测试、文档收尾、Docker 镜像打磨、打 `v0.1` tag。

当前在做什么，见 [Discussions](https://github.com/lorelum/notify-bus/discussions)。

## 项目状态

🟡 **早期开发。** 脚手架和治理文件已就位，核心管道在 M1 落地。现在正是参与方向讨论的好时候 —— 来 [Discussions](https://github.com/lorelum/notify-bus/discussions)。

## 贡献

欢迎贡献。notify-bus 是 **MIT 许可** —— 无 CLA，无 open-core 拆分。Fork、改、用，随你。

- 📖 开发流程见 [**CONTRIBUTING.md**](./CONTRIBUTING.md)（issue-driven + design-first）
- 🤖 用 AI 编程助手？也读一下 [**AGENTS.md**](./AGENTS.md)
- 💬 来 [Discussions](https://github.com/lorelum/notify-bus/discussions) 打招呼或提想法
- 🐛 发现 bug？[提个 issue](https://github.com/lorelum/notify-bus/issues/new/choose)

## License

**MIT** —— 见 [LICENSE](./LICENSE)。整个代码库（服务、管道、适配器、管理前端）都是 MIT 许可。无双许可，无 CLA。
