/**
 * dsh-quit — 浏览器半部：把「退出 dsh」注入侧栏底部的账户菜单。
 *
 * ── 为什么不是普通 slot ───────────────────────────────────────────────────
 * 侧栏底部那个头像（或 ⋯）按钮弹出的菜单（设置 / 联系我们 / 登录或退出登录）
 * 是官方账户插件的 `settings.launcher` 座位，**菜单项写死在官方插件内部**
 * （`dsh-client-ui-settings-account` 的 `AccountMenu.items`），平台没有为它提供
 * 任何“追加一条菜单项”的 slot。`settings.launcher` 本身是 single 座位，占用即
 * 替换整个账户入口 —— 那会丢掉头像、余额、登录/退出登录，代价太大。
 *
 * 所以这里用**只追加、不改写**的 DOM 注入：
 *   1. 监听 body 的 MutationObserver；
 *   2. 菜单一出现（`[role="menu"]` 且文本含两个以上账户菜单特征词）就克隆最后
 *      一条菜单项，把文字换成「退出 dsh」，插到菜单末尾；
 *   3. 点击注入项 → 打开我们自己的确认面板（`shell.overlay`），确认后走
 *      `/dsh-quit/quit`。
 *
 * 失败模式是安全的：找不到菜单 / 结构对不上 → 什么都不注入，官方菜单原样可用。
 * React 重渲染把注入节点冲掉时，下一轮 MutationObserver 会重新注入（幂等）。
 *
 * ── 行为（用户明确要求）───────────────────────────────────────────────────
 * 确认后 Host 半部直接把响应送回浏览器，随即结束进程 —— 在 DSHM 里 Host 就是
 * App 进程内的主 node 线程，于是 **DSHM 直接消失回桌面**（等同划掉后台）。
 * 这条路不经过 host-stop-request，不会出现“服务停了、界面还留着”的半死状态。
 *
 * ── 数据通道 ──────────────────────────────────────────────────────────────
 *   POST /dsh-quit/quit     带 `x-dsh-quit: 1`
 *
 * @module dsh-quit/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-quit',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const NS = 'dsh-quit'
    const STYLE_ID = 'dsh-quit-style'

    /** 取第一个能解析的平台模块；全失败时返回 undefined（降级而非抛错）。 */
    function optionalRequire(...specifiers) {
      for (const specifier of specifiers) {
        try {
          const resolved = require(specifier)
          if (resolved !== undefined && resolved !== null) return resolved
        } catch {
          // 下一个
        }
      }
      return undefined
    }

    const platformReact = optionalRequire('react')

    /** 构造元素：优先平台 React，缺 React 时退化为可被 slot 渲染器接受的描述。 */
    function element(type, props, ...children) {
      if (platformReact !== undefined && typeof platformReact.createElement === 'function') {
        return platformReact.createElement(type, props, ...children)
      }
      return {
        type,
        props: Object.assign({}, props, {
          children: children.length > 1 ? children : children[0],
        }),
      }
    }

    /** 平台 hooks；缺 React 时给惰性实现，让模块求值永不出错。 */
    const useState =
      platformReact !== undefined && typeof platformReact.useState === 'function'
        ? platformReact.useState
        : (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
    const useEffect =
      platformReact !== undefined && typeof platformReact.useEffect === 'function'
        ? platformReact.useEffect
        : () => {}

    /* ------------------------------------------------------------------ *
     * 模块级 bridge：注入项与 overlay 面板共享状态
     * ------------------------------------------------------------------ */

    const bridge = {
      /** 面板是否打开。 */
      open: false,
      /** 'menu' | 'confirm' | 'sent' */
      view: 'menu',
      /** 动作：固定为 'quit'（重启功能已按用户要求去除） */
      action: 'quit',
      /** 请求进行中。 */
      busy: false,
      /** 已请求的动作（用于 sent 视图文案）。 */
      sentAction: 'quit',
      /** 错误文案。 */
      error: '',
    }
    const bridgeListeners = new Set()

    /** 合并补丁并通知订阅者。 */
    function publish(patch) {
      Object.assign(bridge, patch)
      for (const listener of bridgeListeners) listener()
    }

    /** 订阅 bridge 的 hook。 */
    function useBridge() {
      const [value, setValue] = useState(bridge)
      useEffect(() => {
        const listener = () => setValue(Object.assign({}, bridge))
        bridgeListeners.add(listener)
        return () => {
          bridgeListeners.delete(listener)
        }
      }, [])
      return value
    }

    /** 恢复初始状态（关闭面板时调用）。 */
    function resetBridge() {
      publish({ open: false, view: 'menu', action: 'quit', busy: false, sentAction: 'quit', error: '' })
    }

    /* ------------------------------------------------------------------ *
     * 账户菜单注入（只追加，不改写官方节点）
     * ------------------------------------------------------------------ */

    /** 注入节点的标记属性，用于幂等与识别。 */
    const INJECTED_ATTR = 'data-dsh-quit-item'
    /** 账户菜单的文本特征（中文为主，英文兜底）。至少命中两个才算。 */
    const MENU_HINTS = ['设置', '联系我们', '退出登录', '登录', 'Settings', 'Contact', 'Sign out', 'Sign in']
    /** 扫描节流间隔（毫秒）。 */
    const SCAN_THROTTLE_MS = 120

    let menuObserver = null
    let scanTimer = 0

    /** 判断一个 `[role="menu"]` 是不是侧栏账户菜单。 */
    function looksLikeAccountMenu(menu) {
      const text = String(menu.textContent === null || menu.textContent === undefined ? '' : menu.textContent)
      if (text === '') return false
      let hits = 0
      for (const hint of MENU_HINTS) {
        if (text.indexOf(hint) >= 0) hits += 1
      }
      return hits >= 2
    }

    /** 找到当前打开的账户菜单（没有则返回 null）。 */
    function findAccountMenu() {
      const menus = document.querySelectorAll('[role="menu"]')
      for (const menu of menus) {
        if (looksLikeAccountMenu(menu)) return menu
      }
      return null
    }

    /** 把节点里的文本换成给定标签，尽量保留原有的图标节点与结构。 */
    function rewriteLabel(root, text) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
      const nodes = []
      let node = walker.nextNode()
      while (node !== null) {
        nodes.push(node)
        node = walker.nextNode()
      }
      if (nodes.length === 0) {
        root.textContent = text
        return
      }
      for (let i = 0; i < nodes.length; i += 1) {
        nodes[i].nodeValue = i === nodes.length - 1 ? text : ''
      }
    }

    /** 敲 Escape 让官方菜单自己关掉；关不掉也无妨，我们的面板盖在上面。 */
    function requestCloseMenu() {
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      } catch {
        // 老浏览器不支持 KeyboardEvent 构造：忽略
      }
    }

    /** 构造一个与官方菜单图标同尺寸的电源图标（inline SVG，颜色跟随 currentColor）。 */
    function makePowerIcon() {
      const svgNs = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(svgNs, 'svg')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.6')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('aria-hidden', 'true')
      const arc = document.createElementNS(svgNs, 'path')
      arc.setAttribute('d', 'M4.4 3.9a5.2 5.2 0 1 0 7.2 0')
      const bar = document.createElementNS(svgNs, 'path')
      bar.setAttribute('d', 'M8 1.8v5.4')
      svg.appendChild(arc)
      svg.appendChild(bar)
      return svg
    }

    /** 把注入结果上报给 Host（写进 dsh-quit.log），便于真机排错。 */
    function reportDiag(stage, detail) {
      try {
        void fetch('/dsh-quit/diag', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-dsh-quit': '1' },
          body: JSON.stringify({
            stage: String(stage),
            detail: String(detail === undefined || detail === null ? '' : detail).slice(0, 400),
          }),
        })
      } catch (error) {
        // 诊断失败不影响注入
      }
    }

    /**
     * 往账户菜单末尾追加一条「退出 dsh」。
     *
     * 外观策略（用户要求“显眼 + 原生”）：
     *   · 外壳直接克隆官方菜单项 → 行高、内边距、hover、字体全部原生；
     *   · 图标换成同尺寸电源符号（颜色走 currentColor）；
     *   · 文字与图标用官方语义危险色（--dsw-alias-state-error-primary）；
     *   · 用 borderTop 画分隔线（不插入额外兄弟节点，避免 React 重渲染冲突）。
     *
     * 视觉增强整体包在 try/catch 里：任何一步失败都退回纯文字项 ——
     * 绝不能因为“变好看”失败而导致入口消失（v0.8.0 真机上出现过）。
     */
    function injectMenuItem(menu) {
      const items = menu.querySelectorAll('[role="menuitem"], button')
      const source = items.length > 0 ? items[items.length - 1] : menu.lastElementChild
      if (source === null || source === undefined) return
      const parent = source.parentElement
      if (parent === null || parent === undefined) return
      if (menu.querySelector('[' + INJECTED_ATTR + ']') !== null) return
      const clone = source.cloneNode(true)
      clone.setAttribute(INJECTED_ATTR, '1')
      clone.setAttribute('aria-label', '退出 dsh')
      clone.removeAttribute('id')
      clone.removeAttribute('disabled')
      clone.removeAttribute('aria-disabled')
      clone.removeAttribute('aria-checked')
      rewriteLabel(clone, '退出 dsh')

      let enhanced = 'plain'
      try {
        const oldIcon = clone.querySelector('svg')
        const powerIcon = makePowerIcon()
        if (oldIcon !== null && oldIcon !== undefined) {
          if (typeof oldIcon.replaceWith === 'function') {
            oldIcon.replaceWith(powerIcon)
          } else if (oldIcon.parentNode !== null && oldIcon.parentNode !== undefined) {
            oldIcon.parentNode.replaceChild(powerIcon, oldIcon)
          }
        } else {
          clone.insertBefore(powerIcon, clone.firstChild)
        }
        clone.style.background = 'var(--dsw-alias-state-error-primary)'
        clone.style.color = '#ffffff'
        clone.style.borderRadius = '8px'
        clone.style.margin = '4px 6px'
        clone.style.justifyContent = 'flex-start'
        enhanced = 'icon+solid-red'
      } catch (error) {
        enhanced = 'plain:' + String(error !== null && error !== undefined && error.message ? error.message : error)
      }

      // capture 阶段先拿到事件：官方菜单靠冒泡处理点击，我们把它截在这里。
      clone.addEventListener(
        'click',
        (event) => {
          event.preventDefault()
          event.stopPropagation()
          publish({ open: true, view: 'menu', busy: false, error: '' })
          requestCloseMenu()
        },
        true,
      )
      parent.insertBefore(clone, source.nextSibling)
      reportDiag('injected', enhanced)
    }



    /** 节流扫描：菜单打开期间 React 重渲染会冲掉注入节点，这里补回来。 */
    function scheduleScan() {
      if (scanTimer !== 0) return
      scanTimer = window.setTimeout(() => {
        scanTimer = 0
        const menu = findAccountMenu()
        if (menu !== null) injectMenuItem(menu)
      }, SCAN_THROTTLE_MS)
    }

    /**
     * 安装注入器。
     * @returns {() => void} 卸载函数
     */
    function installMenuInjector() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
        return () => {}
      }
      const start = () => {
        if (menuObserver !== null) return
        menuObserver = new MutationObserver(scheduleScan)
        menuObserver.observe(document.body, { childList: true, subtree: true })
      }
      start()
      const onClick = () => scheduleScan()
      document.addEventListener('click', onClick, true)
      scheduleScan()
      return () => {
        if (menuObserver !== null) {
          menuObserver.disconnect()
          menuObserver = null
        }
        document.removeEventListener('click', onClick, true)
        if (scanTimer !== 0) {
          window.clearTimeout(scanTimer)
          scanTimer = 0
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * 样式：全部引用 DSH 主题 token，明暗自适应
     * ------------------------------------------------------------------ */

    const CSS =
      '.dq-overlay{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.36)}' +
      '.dq-dialog{width:min(380px,calc(100vw - 32px));padding:18px 18px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:14px;box-shadow:0 18px 48px rgba(0,0,0,.35)}' +
      '.dq-title{margin:0 0 8px;font-size:16px;font-weight:600}' +
      '.dq-desc{margin:0 0 14px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.65}' +
      '.dq-actions{display:flex;flex-direction:column;gap:8px}' +
      '.dq-btn{display:flex;align-items:center;justify-content:center;gap:8px;height:38px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;cursor:pointer}' +
      '.dq-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}' +
      '.dq-btn:disabled{opacity:.5;cursor:not-allowed}' +
      '.dq-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}' +
      '.dq-foot-actions{display:flex;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap}' +
      '.dq-btn-sm{height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}' +
      '.dq-btn-sm:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}' +
      '.dq-btn-sm:disabled{opacity:.5;cursor:not-allowed}' +
      '.dq-error{margin:10px 0 0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6}' +
      '.dq-note{margin:12px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.7}' +
      '.dq-sent{padding:6px 0 2px;text-align:center}' +
      '.dq-sent-title{margin:0 0 8px;font-size:15px;font-weight:600}' +
      '.dq-sent-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}' +
      '[data-dsh-quit-item]{background:var(--dsw-alias-state-error-primary) !important;color:#fff !important;border-radius:8px;margin:4px 6px}' +
      '[data-dsh-quit-item]:hover{filter:brightness(.92)}' +
      '[data-dsh-quit-item]:active{filter:brightness(.84)}' +
      '[data-dsh-quit-item] svg{stroke:currentColor}'

    /** 只在第一次渲染时注入样式表。 */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-dsh-plugin', NS)
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /* ------------------------------------------------------------------ *
     * 请求
     * ------------------------------------------------------------------ */

    /** 请 Host 结束进程（= 退出 App）。 */
    async function sendRequest(action) {
      publish({ busy: true, error: '' })
      try {
        const response = await fetch('/dsh-quit/quit', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { accept: 'application/json', 'x-dsh-quit': '1' },
        })
        const body = await response.json().catch(() => null)
        if (response.ok !== true || body === null || body.ok !== true) {
          const detail = body !== null && typeof body.error === 'string' ? body.error : 'HTTP ' + String(response.status)
          throw new Error(detail)
        }
        publish({ busy: false, view: 'sent', sentAction: action, error: '' })
      } catch (reason) {
        const message = reason !== null && typeof reason === 'object' && typeof reason.message === 'string' ? reason.message : String(reason)
        publish({ busy: false, error: '请求失败：' + message })
      }
    }

    /* ------------------------------------------------------------------ *
     * 确认面板（shell.overlay）
     * ------------------------------------------------------------------ */

    /** 已请求后的提示。 */
    function SentView() {
      return element(
        'div',
        { className: 'dq-sent' },
        element('p', { className: 'dq-sent-title' }, '正在退出 dsh'),
        element(
          'p',
          { className: 'dq-sent-desc' },
          'App 会直接关闭、回到桌面（等同划掉后台），下次打开时 dsh 重新启动。本页届时会一起消失，可以安全关闭。',
        ),
      )
    }

    /** 面板本体。 */
    function QuitPanel() {
      const state = useBridge()
      if (state.open !== true) return null

      let body = null
      if (state.view === 'sent') {
        body = element('div', null, SentView())
      } else if (state.view === 'confirm') {
        body = element(
          'div',
          null,
          element('h2', { className: 'dq-title' }, '退出 dsh'),
          element('p', { className: 'dq-desc' }, '将直接关闭 dsh 进程（App 回到桌面）。正在进行的对话会被中断，已落盘的会话内容不会丢。'),
          element(
            'div',
            { className: 'dq-foot-actions' },
            element(
              'button',
              {
                type: 'button',
                className: 'dq-btn-sm dq-btn-danger',
                disabled: state.busy === true,
                onClick: () => {
                  if (state.busy === true) return
                  void sendRequest('quit')
                },
              },
              state.busy === true ? '正在退出…' : '确认',
            ),
            element(
              'button',
              {
                type: 'button',
                className: 'dq-btn-sm',
                disabled: state.busy === true,
                onClick: () => publish({ view: 'menu', error: '' }),
              },
              '取消',
            ),
          ),
          state.error === '' ? null : element('p', { className: 'dq-error' }, state.error),
        )
      } else {
        body = element(
          'div',
          null,
          element('h2', { className: 'dq-title' }, '退出 dsh'),
          element('p', { className: 'dq-desc' }, '直接关闭 dsh 进程、回到桌面（等同划掉后台），下次打开应用时 dsh 重新启动。'),
          element(
            'div',
            { className: 'dq-actions' },
            element(
              'button',
              {
                type: 'button',
                className: 'dq-btn dq-btn-danger',
                onClick: () => publish({ view: 'confirm', action: 'quit', error: '' }),
              },
              '退出 dsh',
            ),
          ),
          element(
            'div',
            { className: 'dq-foot-actions' },
            element(
              'button',
              {
                type: 'button',
                className: 'dq-btn-sm',
                onClick: () => resetBridge(),
              },
              '关闭',
            ),
          ),
          element(
            'p',
            { className: 'dq-note' },
            '退出会中断正在进行的对话；会话日志逐事件落盘，已落盘内容不会丢。诊断：GET /dsh-quit/state。',
          ),
          state.error === '' ? null : element('p', { className: 'dq-error' }, state.error),
        )
      }


      return element(
        'div',
        {
          className: 'dq-overlay',
          role: 'presentation',
          onClick: (event) => {
            if (event !== null && event !== undefined && event.target === event.currentTarget) resetBridge()
          },
        },
        element(
          'div',
          { className: 'dq-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': '退出 dsh' },
          body,
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * 插件入口
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyles()

        // 样式表与账户菜单注入器随插件卸载一起消失。
        try {
          ctx.effect(() => {
            const stopInjector = installMenuInjector()
            return () => {
              try {
                stopInjector()
              } catch {
                // ignore
              }
              const style = typeof document === 'undefined' ? null : document.getElementById(STYLE_ID)
              if (style !== null && style !== undefined) style.remove()
            }
          })
        } catch {
          // ctx.effect 不可用：最多残留注入器到下次刷新
        }

        const slots =
          ctx !== null && ctx !== undefined && ctx.slots !== undefined
            ? ctx.slots
            : ctx !== null && ctx !== undefined && typeof ctx.get === 'function'
              ? ctx.get('slots')
              : undefined
        if (slots === undefined || slots === null || typeof slots.inject !== 'function') return

        try {
          ctx.effect(() =>
            slots.inject('shell.overlay', () =>
              slots.register({ name: 'shell.overlay', id: 'dsh-quit', order: 60 }, () => element(QuitPanel, null)),
            ),
          )
        } catch {
          // overlay 座位不可用时注入项点了没反应（不拖垮界面）
        }
      },
    }
  },
})
