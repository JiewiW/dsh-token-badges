# dsh-token-badges

Token 徽章：在聊天流里为每一笔 token 花销给出可见的度量。

- **user-token**：每条用户消息气泡下方显示该消息输入到模型请求的 token 数（定价来自 host 端 token 计量服务）；插件/运行时注入的消息（cot-anchor 提醒、runtime-context、skill-catalog、agent-instructions 等）落在 turn/step 内，随「Agent 工作流」折叠一起收起，不在根级堆叠。
- **turn-token**：模型回答流最下方常驻累计当前回合的输出 token 数，随每次模型调用实时增长，turn 结束时显示最终值。

## 安装

```sh
dsh plugin add github:JiewiW/dsh-token-badges#v0.1.0
```

客户端半边（`lib/client.js`）需宿主 `ui-chat` 工作流支持 `user-token` / `turn-token` 两种只读节点 kind；host 半边（`lib/index.js`）提供 `/plugins/token-badges/tokens` 定价接口。发布包已含构建产物（`lib/`），无需编译，装好后重启 DSH 生效。

## 校验

```sh
node verify-fold.mjs <session.jsonl>
```

复刻插件与 `ui-chat` 的折叠决策，输出每枚 `user-token` 徽章的归属结论——用于确认注入消息的徽章确实随工作流折叠、而人类提问的徽章留在根级。

## 结构

- `lib/index.js` —— host 半边：`/plugins/token-badges/tokens` 定价接口，回放会话经 token 计量器对该消息定价。
- `lib/client.js` —— client 半边：两种只读徽章的渲染与位置机制。
- `verify-fold.mjs` —— 折叠归属校验脚本。

## 许可

MIT