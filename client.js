// dsh-restart-button — 客户端半边。
//
// 在标题栏右侧放一个「重启 DSH」按钮。
//
// 座位选的是 `conversation.session.header.utilities`（**list** 类型，右对齐、可追加），
// 不是紧挨着窗口按钮的 `conversation.session.header.corner` —— 后者是 **single**，
// 且 2026-10-16 查运行时发现已被 DSH 自带的一个控件占着（registrant: "mf"），
// 注册上去会把它顶掉。utilities 就在它左边紧挨着，视觉上同一排，且 replaceRisk: none。
//
// 样式只依赖 `--dsw-alias-*` 主题令牌，不 import 任何 Harness Client 包 ——
// 那些包的接口会变，升级后最坏是外观退化，不会白屏。

window.__ModuleLoader__.load({
  id: 'dsh-restart-button',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    const SLOT = 'conversation.session.header.utilities'
    const API = '/api/restart-dsh'
    const h = react.createElement

    // ── 样式（挂一次就够）───────────────────────────────────────────
    const CSS_ID = 'dsh-restart-button/button.css'
    if (typeof document !== 'undefined'
      && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`) === null) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-restart-button'
      style.dataset.pluginCss = CSS_ID
      style.textContent = `
/* ⚠️ -webkit-app-region:no-drag —— **这一条绝不能删**。
 *
 * 2026-10-16 折腾一整晚才找到：DSH 的标题栏那一条（顶部约 0~36px）是 Electron 的
 * **可拖拽区域**（-webkit-app-region:drag）。页面里别的可交互元素都显式写了 no-drag，
 * 而本插件一开始没写 ⇒ 鼠标按下去被窗口解释成"拖窗口"，**事件根本不送给网页**。
 *
 * 症状极具误导性：DOM 完全正常、elementFromPoint 也返回"这一点上就是按钮"、
 * getComputedStyle 看不出任何异常 —— 因为这一层**不在 DOM/层叠上下文的范畴里**，
 * 是窗口把那个区域从网页手里拿走了。所以靠调 z-index / 换 Slot / 换挂载方式
 * （本鱼试了六轮）**全都无效**。
 *
 * 加 no-drag 之后立刻能点，位置也能回到标题栏那条（本人最初就想要的位置）。
 */
.dsr-btn{position:fixed;top:9px;right:148px;-webkit-app-region:no-drag;display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:12px;line-height:1;
  color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l2);
  border-radius:6px;padding:3px 8px;cursor:pointer;flex:none;white-space:nowrap;
  transition:color var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease-in-out),
    border-color var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease-in-out),
    background-color var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease-in-out)}
.dsr-btn:hover:enabled{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-interactive-bg-hover)}
.dsr-btn:disabled{cursor:default;opacity:.75}
.dsr-icon{font-size:13px;line-height:1;display:inline-block}
.dsr-sending .dsr-icon{animation:dsr-spin .9s linear infinite}
@keyframes dsr-spin{to{transform:rotate(360deg)}}
.dsr-done{color:var(--dsw-alias-state-warn-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}
.dsr-error{color:var(--dsw-alias-state-error-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
`
      document.head.appendChild(style)
    }

    function RestartButton() {
      const [phase, setPhase] = react.useState('idle')
      const [note, setNote] = react.useState('')

      const onClick = react.useCallback(() => {
        if (phase === 'sending' || phase === 'done') return
        setPhase('sending')
        setNote('')
        fetch(API, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ delaySeconds: 1 }),
        })
          .then(async (response) => {
            const body = await response.json().catch(() => null)
            if (!response.ok || body === null || body.ok !== true) {
              throw new Error((body && body.error) || `HTTP ${response.status}`)
            }
            setPhase('done')
            setNote(`${body.delay} 秒后重启`)
          })
          .catch((error) => {
            setPhase('error')
            setNote((error && error.message) || '投递失败')
          })
      }, [phase])

      const label = phase === 'done' ? `${note}…` : phase === 'error' ? '重启失败' : '重启'

      return h('button', {
        type: 'button',
        className: `dsr-btn dsr-${phase}`,
        title: phase === 'idle' ? '重启 DSH（1 秒后）' : note || '重启 DSH',
        'aria-label': '重启 DSH',
        disabled: phase === 'sending' || phase === 'done',
        onClick,
      }, h('span', { className: 'dsr-icon', 'aria-hidden': 'true' }, '⟳'), h('span', { className: 'dsr-text' }, label))
    }

    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: 'restart-button',
        order: 100,
        label: () => '重启 DSH',
      }, RestartButton))
    }

    exports.apply = apply
    exports.inject = inject
    exports.RestartButton = RestartButton
    return module.exports
  },
})
