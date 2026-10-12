# @hwcwy/opencode-usage-bar

OpenCode V2 的**事件驱动用量条**：在 prompt footer 和 sidebar 显示 **Command Code** 与 **OpenCode Go** 的额度窗口（5h / 周 / 月）。

与常见"定时轮询"插件不同：它监听会话当前选中的模型，**切换供应商时立刻拉取该供应商的用量**，不用等下一个刷新周期；其余已启用供应商仍按间隔后台刷新。

```
# prompt footer（方块条 + 倒计时 + 阈值变色）
CC 5h █████░░░░░ 51% · week █████████▌ 95% · 3h 39m

# sidebar
Usage
  Command Code · goat
    5h     █████░░░░░  51%  3h 39m
    week   █████████▌  95%  2d 4h
    month  ██████░░░░  48%  $36.67 left
  OpenCode Go · go
    5h     ░░░░░░░░░░   0%  44m
    week   ░░░░░░░░░░   0%  6d 0h
    month  █████████▊  98%  12d 8h
```

## 安装

```bash
# GitHub（推荐）
opencode plugin add github:hwcwy/opencode-usage-bar
```

CLI/TUI 插件写入 `~/.config/opencode/cli.json`，**重启 OpenCode TUI 生效**。更新：

```bash
opencode plugin update github:hwcwy/opencode-usage-bar
```

本地开发时 `opencode plugin add` 不接受 `file://`，需要手动写进 `cli.json`：

```jsonc
{ "plugins": ["file:///C:/path/to/opencode-usage-bar"] }
```

## 凭据

按顺序查找，无需额外配置即可复用 OpenCode 已连接的凭据：

1. `usage-bar.jsonc` 里的 `apiKey`（支持 `{env:NAME}`）或 `authPath`
2. OpenCode auth：`$XDG_DATA_HOME/opencode/auth.json` →（Windows）`%LOCALAPPDATA%\opencode\auth.json` → `~/.local/share/opencode/auth.json` → `~/.config/opencode/auth.json`，取 `commandcode` / `opencode-go` 条目
3. 环境变量：`COMMANDCODE_API_KEY` / `OPENCODE_API_KEY`

## 配置

`~/.config/opencode/usage-bar.jsonc`（可选，全部有默认值）：

```jsonc
{
  "$schema": "<本仓库>/usage-bar.schema.json",
  "refreshIntervalSeconds": 60,   // 后台间隔；选中模型的供应商总是立即刷新（最小 15）
  "barWidth": 10,                 // 进度条方块数
  "warnPercent": 70,              // ≥ 该值变黄
  "errorPercent": 90,             // ≥ 该值变红
  "providers": {
    "commandcode": { "enabled": true },
    "opencode-go": { "enabled": true, "label": "Go" }
  }
}
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `/usage-bar`（命令面板同名项） | 立即强制刷新所有供应商 |

## 数据来源

| 供应商 | 端点 | 窗口 |
| --- | --- | --- |
| Command Code | `/alpha/whoami`、`/alpha/billing/credits`、`/alpha/billing/subscriptions`、`/alpha/usage/summary`（Bearer API key） | 5h / weekly 来自 `windowLimits`；month 用本计费周期消费 vs 剩余 credits 推算 |
| OpenCode Go | `https://opencode.ai/zen/go/v1/usage`（Bearer API key） | `usage.rolling` / `weekly` / `monthly` |

## 限制

- 只做 Command Code 与 OpenCode Go（DeepSeek / OpenRouter 等未纳入）。
- Command Code 的 month 窗口是**推算**：需要 `/alpha/usage/summary` 可用；不可用时该行隐藏。
- 免订阅（pay-as-you-go）账号没有窗口，行会自动省略。

## 许可证

[MIT](./LICENSE)
