// dsh-restart-button — host 半边。
//
// 职责只有一件：提供 `POST /api/restart-dsh`，收到就投递一次重启。
//
// 为什么不在客户端直接重启：浏览器跑不了本地进程，必须由宿主侧发起。
//
// 为什么复用 dsh-rescue\restart-desktop.cmd 而不是自己写一套：
//   那套脚本已经过实战（四个坑都填过 —— cmd 引号 / .ps1 的 BOM /
//   **用 WMI 脱离进程树** / 渲染进程连带崩），见工作区错题本第 0.6 条。
//   本插件只负责"按参数投递"，不重复实现。
//
// 延迟默认 **1 秒**：手动点按钮的场合，用户已经知道要重启了，不需要等。
//   （本鱼自己在会话里重启用 30 秒 —— 那是给"把回复写完并落库"留的时间。）
//
// ⚠️ WMI 那一步有个已知副作用：它属于"无文件执行"手法，360 主动防御会弹告警。
//    解法是给 restart-desktop.cmd + restart-inner.ps1 加白名单（已经加过），
//    而不是换掉 WMI。

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-restart-button'

// connection：注册 /api 路由用
// tools / skills：注册 restart_dsh 工具和 skill 用（不列进 inject 的话 ctx.get 拿到的是 undefined）
export const inject = ['connection', 'tools', 'skills']

const DEFAULTS = {
  /** dsh-rescue 那个延迟重启脚本的绝对路径 */
  script: 'F:\\DSH-Data\\deepseek-harness\\default-workspace\\dsh-rescue\\restart-desktop.cmd',
  /** 点一下之后等几秒再重启 */
  delaySeconds: 1,
  /** 启动后是否自动在最近活跃会话发「继续任务」 */
  autoContinue: true,
  /** 自动继续延后多少毫秒（给 DSH 一点时间把服务准备好） */
  autoContinueDelayMs: 5000,
  /** 自动继续发的内容 */
  autoContinuePrompt: '继续任务',
}

// ── 自动继续（2026-10-22 跟重启键合进同一个插件）────────────────────────
// 需求：点重启键 → DSH 重开 → 自动在最近活跃会话发一句「继续任务」
//      省得调试插件时每次手动打字。
// 做法：apply 时挂一个一次性定时器 → 找最近活跃会话 → schedule.create 5 秒后触发。

/** RFC3339 字符串（schedule.create 的 at 只有对象形式才是分钟精度，字符串能到秒） */
function toRfc3339(d) {
  const pad = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  )
}

/** 找「最近活跃的会话」：跟设置页下拉框判据一致 */
async function findLatestSession(ctx) {
  const ctrl = ctx.get('sessionController')
  if (!ctrl || typeof ctrl.list !== 'function') return null

  const v = await ctrl.list({}, AbortSignal.timeout(5000))
  const items = (v && v.items) || []
  if (!items.length) return null

  const candidates = []
  for (const s of items) {
    try {
      const id = String(s.sessionId || '')
      if (!id) continue
      if (s.archived) continue
      if (s.origin === 'subagent') continue
      if (s.blank) continue
      const proj = (s.projections && s.projections.values) || {}
      const title = String(
        proj.title || proj['session-title'] || proj.sessionTitle || '',
      ).trim()
      if (!title) continue
      candidates.push({ id, title, updatedAt: Number(s.updatedAt) || 0 })
    } catch {
      /* 单条坏了跳过 */
    }
  }

  if (!candidates.length) return null
  candidates.sort((a, b) => b.updatedAt - a.updatedAt)
  return candidates[0]
}

/** 启动后等一下，然后往最近活跃会话发「继续任务」 */
async function autoContinue(ctx, config, diagFn) {
  try {
    const schedule = ctx.get('schedule')
    if (!schedule || typeof schedule.create !== 'function') {
      diagFn('自动继续跳过：没有 schedule 服务')
      return
    }

    const target = await findLatestSession(ctx)
    if (!target) {
      diagFn('自动继续跳过：没找到合适的会话（可能全空/全归档/没标题）')
      return
    }

    const at = toRfc3339(new Date(Date.now() + 5000))
    await schedule.create(target.id, {
      title: '自动继续（DSH 启动触发）',
      prompt: config.autoContinuePrompt,
      at,
    })
    diagFn(`自动继续已投递：会话=${target.id.slice(-8)}（${target.title.slice(0, 20)}）at=${at}`)
  } catch (e) {
    diagFn(`自动继续失败：${e?.message ?? e}`)
  }
}


let logFile = ''

function harnessHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(homedir(), '.dsh')
}

function diag(line) {
  try {
    if (logFile === '') return
    mkdirSync(dirname(logFile), { recursive: true })
    writeFileSync(logFile, `${new Date().toISOString()} [dsh-restart-button] ${line}\n`, {
      flag: 'a',
      encoding: 'utf8',
    })
  } catch {
    /* 日志失败绝不影响功能 */
  }
}

/**
 * 投递一次重启。
 *
 * `restart-desktop.cmd` 自己会用 **WMI** 去创建 `restart-inner.ps1` ——
 * 真正"杀掉所有 DeepSeek Harness 再拉起来"的是后者，它脱离了 DSH 的进程树，
 * 所以 DSH 被杀时它还活着，能把 DSH 拉回来。
 * 我们这个 cmd 只做"投递"这一步，很快退出，留在树里无害。
 */
function dispatchRestart(script, delaySeconds) {
  if (!existsSync(script)) {
    return Promise.reject(new Error(`找不到重启脚本：${script}`))
  }
  const delay = Math.max(1, Math.floor(Number(delaySeconds) || DEFAULTS.delaySeconds))
  return new Promise((resolve, reject) => {
    execFile('cmd.exe', ['/c', script, String(delay)], {
      windowsHide: true,
      timeout: 15000,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`投递重启失败：${error.message}`
          + (stderr ? `｜${String(stderr).slice(0, 200)}` : '')))
        return
      }
      resolve({ delay, script, out: String(stdout || '').slice(0, 300) })
    })
  })
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS }
  if (rawConfig !== null && typeof rawConfig === 'object') {
    if (typeof rawConfig.script === 'string' && rawConfig.script.trim() !== '') {
      config.script = rawConfig.script.trim()
    }
    if (Number.isFinite(Number(rawConfig.delaySeconds))) {
      config.delaySeconds = Math.max(1, Math.floor(Number(rawConfig.delaySeconds)))
    }
  }
  logFile = join(harnessHome(), 'restart-button.log')
  diag(`apply 已进入：脚本=${config.script} 延迟=${config.delaySeconds}s 脚本存在=${existsSync(config.script)}`)

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/restart-dsh',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        let body = {}
        try {
          body = await request.json()
        } catch {
          /* 没带 body 就用默认延迟 */
        }
        const result = await dispatchRestart(config.script, body?.delaySeconds ?? config.delaySeconds)
        diag(`已投递重启：延迟 ${result.delay}s`)
        return Response.json({ ok: true, ...result })
      } catch (error) {
        diag(`投递失败：${error?.message ?? error}`)
        return Response.json({ ok: false, error: error?.message ?? String(error) }, { status: 500 })
      }
    },
  }), 'dsh-restart-button: /api/restart-dsh')

  // ── 自动继续：启动后往最近活跃会话发「继续任务」──
  if (config.autoContinue !== false) {
    ctx.effect(() => {
      let cancelled = false
      const timer = setTimeout(() => {
        if (cancelled) return
        void autoContinue(ctx, config, diag)
      }, Math.max(500, Number(config.autoContinueDelayMs) || 5000))

      return () => {
        cancelled = true
        try { clearTimeout(timer) } catch { /* ignore */ }
      }
    }, 'dsh-restart-button: 启动后自动继续')
  }

  // ── AI 可用的 restart_dsh 工具（2026-10-22 加）──────────────────────
  // 目的：别的电脑装了本插件后，Agent 在需要重启时能【自己重启】，
  //       不用发消息让用户去点按钮。
  //
  // ⚠️ 延迟默认 1 秒（跟按钮一致，用户 2026-10-22 明确要求）。
  //     前提是「先把话说完再调工具」—— 这是正常的调用顺序。
  //
  // ⚠️ 注册时必须给 output: { schema, render } —— 只给 schema 会被拒：
  //      tool "xxx" must declare output { schema, render, presentationMeta? }
  try {
    const tools = ctx.tools || ctx.get('tools')
    diag(`tools 服务：${tools ? (typeof tools.register) : 'undefined'}`)
    if (tools && typeof tools.register === 'function') {
      tools.register({
        name: 'restart_dsh',
        description:
          '重启 DSH 本体（点一下右上角那个重启键的等价操作，但由你自己发起）。'
          + '**装这个功能就是为了让你在需要重启时自己重启** —— 不要再发消息让用户手动点按钮。'
          + '\n\n什么时候该用：'
          + '\n· 装/卸/升级了插件，需要 DSH 重新加载才生效'
          + '\n· 改了会被缓存的代码（宿主插件 index.js / client 插件 client.js）'
          + '\n· 用户明确说「重启一下」'
          + '\n\n什么时候别用：'
          + '\n· 只是想刷新页面 —— 那用浏览器刷新就够了'
          + '\n· 当前这一轮还有没写完的结论要告诉用户（先把话说完再调）'
          + '\n\n调用后：DSH 会在 delaySeconds 秒后断连并自动起来；'
          + '如果你开了 feiyu 的自动继续，起来后会自动收到「继续任务」。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delaySeconds: {
              type: 'integer',
              description:
                '延迟几秒后重启（默认 1，跟右上角那个重启键一致）。'
                + '正常用法：先把要跟用户说的话说完，再调这个工具 —— 1 秒足够。',
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              delay: { type: 'integer', description: '实际采用的延迟秒数' },
              detail: { type: 'string', description: '结果摘要' },
            },
          },
          // ⚠️ 必须给 render —— 只给 schema 会被拒：
          //    tool "xxx" must declare output { schema, render, presentationMeta? }
          render: (_args, value) => [
            { type: 'text', text: String(value?.detail || '已投递重启') },
          ],
        },
        async execute(args) {
          try {
            const want = Number(args?.delaySeconds)
            const delay = Number.isFinite(want) ? Math.max(1, Math.floor(want)) : 1
            const result = await dispatchRestart(config.script, delay)
            diag(`AI 调用了 restart_dsh：延迟 ${result.delay}s`)
            return {
              ok: true,
              delay: result.delay,
              detail: `已投递重启：DSH 会在 ${result.delay} 秒后断连并自动起来。`
                + '（现在把要告诉用户的话说完就行）',
            }
          } catch (error) {
            diag(`restart_dsh 失败：${error?.message ?? error}`)
            return {
              ok: false,
              delay: 0,
              detail: `重启失败：${error?.message ?? String(error)}`,
            }
          }
        },
      })
    }
  } catch (e) {
    diag(`注册 restart_dsh 失败：${e?.message ?? e}`)
  }

  // ── 注册 skill：告诉 AI 有这个工具、什么时候用 ─────────────────────
  try {
    const skills = ctx.skills || ctx.get('skills')
    if (skills && typeof skills.register === 'function') {
      const content = [
        '# 重启 DSH',
        '',
        '本环境装了 `dsh-restart-button` 插件，提供一个工具 **`restart_dsh`**。',
        '',
        '## 核心约定',
        '',
        '**遇到需要重启 DSH 的情况，直接调用 `restart_dsh` —— 不要发消息让用户自己去点右上角按钮。**',
        '',
        '## 什么时候该重启',
        '',
        '- 装 / 卸 / 升级了插件，需要重新加载才生效',
        '- 改了会被缓存的代码（宿主插件 `index.js`、client 插件 `client.js`）',
        '- 用户明确说「重启一下」',
        '',
        '## 什么时候别重启',
        '',
        '- 只是想刷新页面 —— 浏览器刷新就够',
        '- 这一轮还有结论没说完 —— 先把话说完，再调工具',
        '',
        '## 参数',
        '',
        '`delaySeconds`（默认 1，跟右上角那个重启键一致）—— 延迟几秒后重启。',
        '正常用法：先把要跟用户说的话说完，再调这个工具 —— 1 秒足够。',
        '',
        '## 调用之后',
        '',
        'DSH 会在你指定的秒数后断连并自动起来。',
        '如果本插件开着「自动继续」，起来后会自动在最近活跃的会话里收到「继续任务」，',
        '你接着干就行。',
      ].join('\n')

      skills.register({
        name: 'restart-dsh',
        description:
          '需要重启 DSH 时（装/卸插件、改被缓存的代码、用户要求）用 restart_dsh 工具自己重启，'
          + '别发消息让用户手动点按钮。',
        content,
        source: 'plugin:dsh-restart-button',
      })
    }
  } catch (e) {
    diag(`注册 restart-dsh skill 失败：${e?.message ?? e}`)
  }

  return { config }
}
