# Codex Model Bridge

一个轻量的本机 Responses API 网关，在 Codex 的同一模型菜单中使用官方订阅、OpenAI API 和 DeepSeek API，并按模型记录网关观察到的 token 用量。提供网页管理和可供 Codex 使用的 [Skill](SKILL.md)，不依赖第三方 npm 包。

这是实验项目。新建的网关聊天已验证普通对话跨模型续接；旧聊天自动迁移、长对话和全部原生工具尚未验证。项目不保证任何赠送 credits 的适用性或扣款来源。

## 能做什么

- 保留官方模型原始 ID，为每个 API 模型使用独立别名；DeepSeek Flash 与 V4 Pro 共用同一家 Key。
- 通过 Codex 自身的配置接口安装、备份和恢复接入配置。
- 在 macOS 登录钥匙串保存 API Key，后台重启后自动读取。
- 按模型和供应商统计输入、输出、缓存、推理、失败和未知用量。
- 原样转发 JSON/SSE 与工具调用；仅在明确的推理格式拒绝后，对同一路线做一次受限修复重试。
- 提供系统代理检测和不携带 Key 的网络诊断。

| 菜单项 | 上游 | 凭据来源 |
| --- | --- | --- |
| 官方模型 · 订阅 | 官方 Codex 服务 | Codex 当前 ChatGPT 登录 |
| GPT-6.1 Sol · API | OpenAI API | 本机提供的 OpenAI Key |
| DeepSeek Flash · API | DeepSeek API | 本机提供的 DeepSeek Key |
| DeepSeek V4 Pro · API | DeepSeek API | 同一把 DeepSeek Key |

模型示例不代表账户权限保证。使用前确认上游提供相应模型，并使配置和模型目录与当前 Codex 版本一致。

DeepSeek Pro 对应上游 ID `deepseek-v4-pro`。Flash 与 Pro 在 Codex 菜单、网页测试下拉框和用量卡片中分别展示；当前上游目录中 Pro 仅接收文字，Flash 还支持图片。网页的 DeepSeek 卡片可选择要测试的模型，无需再填写一把 Key。模型能力以供应商当前目录和实际响应为准。

## 快速开始

需要 Node.js 24.14+、已安装的 Codex，以及要使用的供应商 API Key。macOS 钥匙串助手还需要 Xcode Command Line Tools；其他平台目前仅支持内存保管。

```bash
git clone https://github.com/Liuyuchang27/codex-model-bridge.git
cd codex-model-bridge
npm test
npm run dashboard -- --codex "$(command -v codex)"
```

如果 `codex` 不在 PATH 中，使用已安装 CLI 的实际路径替换 `--codex` 参数。也可以通过 `CODEX_CLI_PATH` 指定路径。仓库不包含任何个人安装路径。

后台默认仅监听 `http://127.0.0.1:17631/`。首次访问需要本机授权：让 Codex 按 [SKILL.md](SKILL.md) 在本机打开私有 `.runtime/connection.json` 的一次性 `bootstrapUrl`，不要将该文件或链接发到聊天、Issue 或日志中。网页设置授权 Cookie 后回到普通首页。

在页面中提交 Key，按需勾选保存到本机钥匙串；测试连接会消耗少量相应 API 额度。保持 Codex 的 ChatGPT 登录，点击“启用统一模型菜单”，完全退出并重开 Codex，再用一个新的本地聊天确认菜单。

统一网关聊天中的模型切换无需反复重启。已有聊天可能仍绑定原 provider，仅改变全局配置或模型名称不会自动迁移它。需要回到官方直连时，在后台恢复原订阅配置并重启 Codex。

后台必须保持运行。后台停止时，统一模式下的订阅请求也会失败。项目没有配置登录自动启动。

## 凭据和隐私

API Key 不写入源码、命令参数或用量导出。macOS 可保存到本机登录钥匙串，取消保存后仅在当前后台内存使用。页面不回显已保存的 Key；“移除本机 Key”清除该供应商的内存值和钥匙串条目。移动项目路径后，钥匙串命名空间可能变化，需要重新设置。

订阅 access/refresh token 由 Codex 自行管理，网关不读取或保存这些凭据。官方路线只向固定官方 Codex 地址转发客户端鉴权；API 路线重新构造请求头，不转发 ChatGPT OAuth、账户 ID、Cookie 或会话标识。本机 guard 不发往任何上游。

本机 guard 保存在私有运行目录和权限为 0600 的用户配置中。`.runtime/` 还可能包含配置备份、模型元数据和用量，均属于本机数据。公开仓库只包含源码、合成测试和示例配置，不包含真实凭据、账单、个人路径、聊天 ID 或原始测试回执。详见 [PRIVACY.md](PRIVACY.md)。

## 用量口径

统计只覆盖经过这个网关的请求，不包括官方直连或其他应用。缓存与推理 token 是子集，不重复相加。上游没有返回 usage 时显示“未知”，不估算成零。订阅和 API 用量分别展示；本地 token 数不能证明扣的是赠送余额还是付费余额。

## 网络与代理排查

能使用 ChatGPT，不代表当前网络同时能访问 OpenAI API 或 DeepSeek API。出现 502 时，应先区分网关鉴权、上游 HTTP 拒绝、DNS、TLS 重置和超时，再判断是否与 Key 有关。

后台支持读取 macOS HTTP/HTTPS 系统代理；显式环境变量优先。代理设置改变后可在页面重新读取，无需重填已保存的 Key。网络检测不带 Key、不调用模型；未授权响应说明网络收到了上游响应，不代表 Key 验证通过。

如出现 TLS 重置，应检查自己网络环境中目标 API 域名的节点可达性与分流。保留 TLS 证书校验，并让本机回环连接直连。本项目不提供代理节点、订阅链接、服务商推荐、个人代理地址或可直接导入的代理规则；具体设置由使用者自行管理。

## 升级与兼容

生成器优先读取与客户端版本匹配的模型缓存，否则尝试使用当前 CLI 的 bundled snapshot。目录先写临时文件，经当前 Codex 原生 `model/list` 校验后才发布；每次启用前重新校验。不能保证未来客户端 Schema 永远兼容。

若升级后旧目录导致 Codex 启动失败，可先停用用户配置中的 `model_catalog_json`，恢复启动，再重建并校验目录。不要猜测补字段。后台不自动监听 Codex 更新。

更新后台代码后可执行 `npm run dashboard -- --restart`。保存到钥匙串的 Key 会自动读取；仅内存保管的 Key 在重启后需要重新提交。

## 测试

```bash
npm test
npm run check:public
```

本机自动测试使用合成数据和本机模拟上游，不消耗 API 额度。验证范围见 [TEST_RESULTS.md](TEST_RESULTS.md)。真实 API 检查需要使用者自己的凭据，可能产生费用；其回执必须留在 Git 忽略的本机目录。

已运行后台并配置两家 Key 后，可选择执行五轮临时对话检查：

```bash
npm run unified-probe -- "$(command -v codex)"
```

该探针验证订阅 → OpenAI API → DeepSeek Flash → DeepSeek V4 Pro → 订阅的普通对话历史续接，使用精简说明，不证明全部原生工具或旧聊天迁移。回执写入 `.runtime/receipts/`。其他底层探针见 `scripts/`，不应把小型测试目录用于日常模型配置。

只检查 Flash → Pro → Flash 的三轮历史续接时，可使用：

```bash
npm run unified-probe -- "$(command -v codex)" --deepseek-only
```

此模式只调用 DeepSeek API，需要已有 Codex ChatGPT 登录以使用统一 provider，但不会调用订阅或 OpenAI API 模型，也不改默认模型。回执保存在私有 `.runtime/receipts/deepseek-models.json`，不要提交到公开仓库。

## 限制

- 不支持 WebSocket 或远程 `/responses/compact`；安装器声明远程压缩不受支持，长对话仍需验证。
- 不能解密其他供应商的推理或未知压缩块，也不会静默删除加密中的子任务。
- 不提供 OAuth 账户管理、旧聊天自动迁移或完整压缩包装。
- 不自动切换供应商、充值或重试不明确的网络失败。
- API 赠送 credits 是否适用和如何扣账由上游决定，项目不能强制选择余额来源。

## 致谢与许可

参考 [CC Switch](https://github.com/farion1231/cc-switch) 的聚合模型路由、官方鉴权隔离和受限 reasoning 修复思路。上游固定提交、原始参考文件和 MIT 声明见 [vendor/cc-switch/UPSTREAM.md](vendor/cc-switch/UPSTREAM.md)。原始 Rust 参考文件未链接到 Node 进程。

本项目使用 [MIT License](LICENSE)，保留上游文件各自的版权和许可。
