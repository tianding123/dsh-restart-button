# dsh-restart-button

给 DSH 的一个小插件，管两件事：

1. **标题栏右侧一个「重启 DSH」按钮** —— 点一下，1 秒后重启
2. **启动后自动在最近活跃的会话里发一句「继续任务」** —— 省得调试插件时反复打字

## 为什么把这两件事放一起

因为它们是同一个动作的两半：**点重启 → DSH 重开 → 自动接着说**。
分开做的话你会得到两个都要装的插件，而且还得自己记得配。

## 重启延迟为什么是 1 秒

| 谁按的 | 延迟 | 为什么 |
|---|---|---|
| **你点这个按钮** | **1 秒** | 你已经决定要重启了 —— 点完 1 秒断连、几秒后自动起来，不用等 |
| **Agent 在会话里自己重启** | **30 秒** | 那段延迟是给「把这一轮回复写完并落库」留的时间；写完才断线，回来还能看到 |

两者**复用同一个脚本**（`dsh-rescue\restart-desktop.cmd`），只是参数不同 ——
那个脚本第一个参数就是延迟秒数。

> ⚠️ 这个插件**依赖 dsh-rescue 那套重启脚本**（默认路径写死在 `DEFAULTS.script`）。
> 没有它的话，重启键点了不会有反应。脚本路径可以用 `config.script` 换。

## 它插在哪

标题栏右侧（`titleBarOverlay` 那一排按钮旁边）。

> 已知坑：标题栏那一条是「可拖拽区」（`-webkit-app-region: drag`），
> 放进里面的可点击控件必须显式写 `-webkit-app-region: no-drag`，否则点不动。

## 自动继续怎么工作

```
DSH 启动完成（插件 apply）
  ↓ 等 5 秒（给会话/服务准备的时间）
  ↓ 从 sessionController.list() 拿会话清单（就是侧边栏那批）
  ↓ 过滤：非归档 / 非子代理 / 非空 / 有标题
  ↓ 按 updatedAt 取最新那个
  ↓ schedule.create 建一次性任务，5 秒后触发
  ↓ prompt = 「继续任务」
```

**为什么走 schedule 而不是直接往会话里塞消息：**

- 直接塞要自己造 `UserMessage` + 处理 session 格式版本（v4 的 `source.kind` 必须是 `plugin:<包名>`），容易踩坑
- `schedule` 是 DSH 官方通道，消息会正常进会话、正常触发一轮

**判据跟设置页的会话下拉框完全一致** —— 所以它不会挑到那些侧边栏里根本看不见的空会话。

## 配置

```yaml
config:
  script: 'F:\...\dsh-rescue\restart-desktop.cmd'   # 重启脚本路径
  delaySeconds: 1                                    # 点按钮后等几秒
  autoContinue: true                                 # 启动后要不要自动继续
  autoContinueDelayMs: 5000                          # 启动后等多久再发
  autoContinuePrompt: '继续任务'                      # 发什么
```

## 日志

```
~/.dsh/restart-button.log
```

每次启动会记一行：

```
[2026-10-22T03:28:44.042Z] 自动继续已投递：会话=3df6c527（应用会话）at=2026-10-22T03:28:49+08:00
```

**出问题先看这个文件。**

## 安装

```bash
dsh plugin --profile desktop add github:tianding123/dsh-restart-button
```

装完重启 DSH。

## 已知副作用

重启脚本用 **WMI** 创建独立进程（`restart-inner.ps1`），这样 DSH 被杀时它还能把 DSH 拉回来。
WMI 属于「无文件执行」手法，**360 主动防御会弹告警** —— 解法是给脚本加白名单，而不是换掉 WMI。

## License

MIT
