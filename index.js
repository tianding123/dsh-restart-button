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

// 只需要 connection（注册 /api 路由用）。别的不碰。
export const inject = ['connection']

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

  return { config }
}
