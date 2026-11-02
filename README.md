# Codex Model Bridge

**在 Codex 的同一个模型菜单里，使用官方订阅、OpenAI API 和 DeepSeek。**

Codex Model Bridge 是一个轻量的本机模型网关，配有网页管理面板和一套可供 Codex 执行的 Skill。它把模型接入、Key 保存、配置切换和 token 统计放在一起，让你继续使用熟悉的 Codex 对话界面，同时按任务选择不同的模型。

不需要另做一套聊天客户端，也不依赖第三方 npm 包。后台运行在本机，模型调用发往你选择的供应商。

## 为什么做这个项目

当你已经在用 Codex，也有自己的 OpenAI 或 DeepSeek API Key 时，往往还需要配置不同的接口、找到对应模型、反复填写 Key，以及判断每次调用实际消耗了多少 token。

这个项目把这些操作整理成一个简单的流程：**启动后台 → 填入 Key → 启用统一菜单 → 在 Codex 中选择模型**。既保留官方订阅路线，也为 API 模型提供独立入口；日常管理在网页完成，实际工作仍在 Codex 中继续。

## 核心功能

### 一个菜单，选择多家模型

官方订阅模型保留原始 ID，API 模型使用单独的别名，并在名称中标出“订阅”或“API”，方便确认当前使用的路线。

| 菜单项 | 调用路线 | 使用的凭据 |
| --- | --- | --- |
| 官方模型 · 订阅 | 官方 Codex 服务 | Codex 当前的 ChatGPT 登录 |
| GPT-6.1 Sol · API | OpenAI API | 你提供的 OpenAI API Key |
| DeepSeek Flash · API | DeepSeek API | 你提供的 DeepSeek API Key |
| DeepSeek V4 Pro · API | DeepSeek API | 与 Flash 共用同一把 DeepSeek Key |

首次启用统一菜单后重开一次 Codex，随后可以在同一个网关聊天中切换模型，继续普通对话历史。Flash → Pro → Flash 的双向历史续接已通过真实 Codex 临时对话验证。

### 网页管理，无需反复手改配置

本机网页提供三个主要区域：

| 区域 | 可以做什么 |
| --- | --- |
| 用量总览 | 查看总 token、输入、输出、缓存、推理及请求数，按供应商和模型查看明细 |
| 模型与 API Key | 提交或替换 Key、选择具体模型测试连接、保存或移除本机凭据 |
| Codex 配置 | 选择新聊天的默认模型、启用统一菜单、恢复原官方直连配置 |

另外提供最近请求列表和用量 JSON 导出，便于了解哪些模型正在被调用、请求是否完成，以及上游是否返回了用量。

### 每个模型单独统计 token

OpenAI API、DeepSeek Flash、DeepSeek Pro 和经过网关的官方订阅请求分别统计。即使 Flash 和 Pro 共用一把 Key，也有各自的用量卡片。

- **输入与输出**：查看请求和回复分别使用了多少 token。
- **缓存与推理**：展示上游返回的缓存命中、缓存写入及推理 token。
- **请求状态**：区分完成、失败、未完成，以及没有用量回执的请求。
- **历史记录**：用量记录保存在本机，后台重启后继续累计；页面每 4 秒刷新。

缓存与推理是相应 token 的子集，不重复计入总量。没有上游回执时显示“未知”；统计覆盖经过网关的调用，API 实际费用以供应商账单为准。

### Key 保存在本机，重启后自动读取

macOS 可以将 API Key 保存到登录钥匙串，后台重启后自动读取，不必每次填写。也可选择仅在本次运行的内存中使用；其他平台目前采用内存保管。

网页不回显已保存的 Key，支持替换和移除。API Key 不写入源码、命令参数或用量导出。订阅路线使用 Codex 已有的登录状态，API 路线使用各自的 Key，分别构造鉴权请求。

### 配置有备份，模型目录先验证

安装器通过 Codex 自身的配置接口更新设置，保存原配置备份，并提供恢复入口。模型目录在发布和启用前，先交给当前安装的 Codex 做实际加载校验。

生成器优先使用版本匹配的模型缓存，必要时读取当前 CLI 的内置目录，减少手写模型字段和客户端升级带来的配置问题。

### 网络检测与代理刷新

后台可读取 macOS HTTP/HTTPS 系统代理，显式环境变量优先。网络设置改变后，在网页点击“重新读取系统代理”即可刷新，无需重新填写 Key。

页面还提供不携带 Key 的 API 网络检测，帮助区分网络连接问题与上游鉴权问题。出现 502、DNS 或 TLS 错误时，可先检测目标 API 的可达性，再测试模型。能访问 ChatGPT，并不代表同一网络路线能访问 API。

代理排查以目标 API 的可达性、分流和本机回环直连为重点，保留 TLS 证书校验。本仓库只提供通用排查思路，不提供节点、订阅链接或可直接导入的代理配置。

## 快速开始

### 1. 准备环境

- Node.js **24.14+**。
- 已安装 Codex，并保持 ChatGPT 登录，以使用统一订阅/API 菜单。
- 准备需要使用的供应商 API Key。
- macOS 使用钥匙串保存功能时，需要 Xcode Command Line Tools。

### 2. 下载并启动

```bash
git clone https://github.com/Liuyuchang27/codex-model-bridge.git
cd codex-model-bridge
npm run dashboard -- --codex "$(command -v codex)"
```

如果 `codex` 不在 PATH 中，将 `--codex` 参数替换为实际 CLI 路径，或通过 `CODEX_CLI_PATH` 指定。项目无需执行 `npm install`。

### 3. 打开本机管理面板

后台默认运行在 `http://127.0.0.1:17631/`。首次访问需要完成本机授权：让 Codex 按 [SKILL.md](SKILL.md) 在本机打开私有 `.runtime/connection.json` 中的一次性 `bootstrapUrl`，授权后会返回管理首页。

你也可以直接让 Codex 帮你完成安装：

> 请阅读这个项目的 SKILL.md，启动本机管理面板，打开本机授权页面，并引导我配置统一模型菜单。API Key 由我在本机网页填写。

一次性授权链接和连接文件属于本机私有数据，不要粘贴到聊天或 Issue 中。

### 4. 提交 Key 并启用菜单

1. 在“模型与 API Key”中提交要使用的 Key，按需勾选保存到本机钥匙串。
2. 在供应商卡片中选择模型，点击“测试连接”。DeepSeek Flash 与 Pro 共用同一把 Key，可分别测试。
3. 在“Codex 配置”选择新聊天的默认模型，点击“启用统一模型菜单”。
4. 完全退出并重开 Codex，在新的本地聊天中选择对应模型。

完成后保持后台运行，即可在网关聊天中切换模型，并在网页查看分别累计的用量。连接测试会消耗少量对应 API 额度。

## 日常使用

| 想做什么 | 操作方式 |
| --- | --- |
| 切换本轮使用的模型 | 在 Codex 聊天的模型菜单选择订阅或 API 模型 |
| 使用 DeepSeek Pro | 选择 **DeepSeek V4 Pro · API**，上游 ID 为 `deepseek-v4-pro` |
| 更换 API Key | 在对应供应商卡片提交新 Key |
| 查看 Flash、Pro 各自消耗 | 查看“按模型分别统计”中的独立卡片 |
| 切换网络后重新检测 | 先重新读取系统代理，再检测 API 网络或测试连接 |
| 回到官方直连 | 在管理面板恢复原订阅配置，再重开 Codex |
| 更新后台代码 | 更新源码后执行下面的重启命令 |

```bash
npm run dashboard -- --restart
```

保存到钥匙串的 Key 会自动恢复，历史用量继续保留。统一模式下请保持后台运行；已有聊天如仍绑定原供应商，应新建网关聊天使用统一菜单。

## 工作原理

```text
Codex 模型菜单
      │
      ▼
本机 Model Bridge ─── 网页管理 / Key 保管 / 用量记录
      │
      ├── 官方模型 ID ─────────── 官方 Codex 服务
      ├── openai-api/… ───────── OpenAI API
      └── deepseek/… ─────────── DeepSeek API（Flash / V4 Pro）
```

网关根据模型别名选择上游，使用 Responses API 转发 JSON 或 SSE 流式响应，观察用量回执并写入本机记录。订阅鉴权只转发给固定的官方 Codex 服务，API 路线使用对应供应商的 Key。

对于跨模型历史中的特定推理格式冲突，网关会在上游明确拒绝后，对同一模型执行一次受限修复重试，保留可读对话和工具调用配对。详细实现与验证范围见 [TEST_RESULTS.md](TEST_RESULTS.md) 和 [SKILL.md](SKILL.md)。

## 开发与验证

项目基于 Node.js 内置模块，主要目录如下：

| 路径 | 内容 |
| --- | --- |
| `scripts/` | 请求路由、网页服务、配置安装、钥匙串、网络诊断及用量统计 |
| `web/` | 本机管理面板 |
| `tests/` | 使用合成数据和模拟上游的自动测试 |
| `config.example.json` | 供应商、模型别名及显示名称的示例配置 |
| `SKILL.md` | 供 Codex 执行的安装、配置和验证流程 |
| `vendor/cc-switch/` | 固定版本的上游参考文件、来源和许可 |

运行本机测试和公开文件检查：

```bash
npm test
npm run check:public
```

本机自动测试不消耗供应商额度。运行后台并配置好凭据后，可按需进行真实历史续接测试：

```bash
# 订阅 → OpenAI API → Flash → Pro → 订阅
npm run unified-probe -- "$(command -v codex)"

# 只测试 Flash → Pro → Flash
npm run unified-probe -- "$(command -v codex)" --deepseek-only
```

真实探针使用临时、无工具的 Codex 聊天，可能产生 API 费用；回执保存在私有 `.runtime/receipts/`。

## 使用提示

- 本项目处于实验阶段，当前验证以新建网关聊天的普通对话、基础工具和模型切换为主；完整原生工具、长对话和旧聊天迁移的验证范围见 [TEST_RESULTS.md](TEST_RESULTS.md)。
- 可用模型与能力取决于供应商及账户权限。赠送 credits 是否适用、实际扣款来源由供应商决定，网关不改变额度规则。
- Key、授权链接、配置备份和真实运行记录应保留在本机私有目录。公开前请运行脱敏检查；详见 [PRIVACY.md](PRIVACY.md)。

## 致谢与许可

参考 [CC Switch](https://github.com/farion1231/cc-switch) 的聚合模型路由、官方鉴权隔离和受限 reasoning 修复思路。固定上游提交、原始参考文件与 MIT 声明见 [vendor/cc-switch/UPSTREAM.md](vendor/cc-switch/UPSTREAM.md)。

本项目使用 [MIT License](LICENSE)，保留上游文件各自的版权和许可。
