/**
 * dsh-quit — DSHM 端侧「退出」插件（Host 半部）。
 *
 * ── 要解决什么 ────────────────────────────────────────────────────────────
 * DSHM 把 dsh Host 跑在 App 进程里（`host-ready.json` 的 pid 是 App 进程号，
 * 日志里的 js-tid 是 node 线程号）。用户想退出应用，目前只能去系统多任务里
 * 把 DSHM 划掉。本插件在侧栏底部的账户菜单里加一行「退出 dsh」，点一下直接
 * 结束进程、回到桌面。
 *
 * ── 为什么不走 host-stop-request ──────────────────────────────────────────
 * 那是 App 的“停止 Host”通道：写它之后，App 停的是 Host 服务，界面可能留在
 * 前台显示停止/错误页 —— 用户把这种半死状态称作“断开核心”，明确不要。
 *
 * 用户要的是：**点按钮后 App 直接消失回桌面**（等同划掉后台），下次打开时
 * Host 重新启动。所以在把 HTTP 响应送回浏览器之后，直接 `process.exit(0)`。
 *
 * 代价（已在 README 写明）：这是结束进程，正在进行的模型对话会中断；
 * 会话日志是逐事件落盘的，已落盘内容不会丢。
 *
 * ── 接口 ──────────────────────────────────────────────────────────────────
 *   POST /dsh-quit/quit      → 结束进程（退出 App）
 *   GET  /dsh-quit/state     → 只读诊断
 *
 * 两个 POST 必须带 `x-dsh-quit: 1` 请求头；服务端另外校验 Origin（只认本机同源）。
 *
 * @module dsh-quit
 */

import { appendFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export const name = 'dsh-quit'
export const inject = []

const VERSION = '0.8.1'
const ROUTE_PREFIX = '/dsh-quit'
const ROUTE_QUIT = '/dsh-quit/quit'
const ROUTE_STATE = '/dsh-quit/state'
const ROUTE_DIAG = '/dsh-quit/diag'

/** 本插件自己的诊断日志。 */
const DIAG_FILE = 'dsh-quit.log'

/** 先把 HTTP 响应送回浏览器，再结束进程（否则前端拿不到“正在退出”）。 */
const EXIT_DELAY_MS = 150
/** POST 必须携带的请求头名。 */
const CSRF_HEADER = 'x-dsh-quit'
/** 只接受本机同源触发。 */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]']

const runtime = {
  homeDir: '',
  diagPath: '',
  /** 正在退出时的动作 { action, at }；同一时刻只允许一个。 */
  pending: null,
  /** 最近一次动作，供 /state 诊断。 */
  last: null,
  /** 定时器集合，卸载时清掉。 */
  timers: new Set(),
  /** 插件是否已卸载。 */
  disposed: false,
}

/** 把任意错误压成一行文本。 */
function errText(error) {
  if (error === null || error === undefined) return ''
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return String(error)
}

/** 追加一行诊断。失败不影响主流程。 */
function diag(line) {
  if (runtime.diagPath === '') return
  try {
    appendFileSync(runtime.diagPath, '[' + new Date().toISOString() + '] ' + line + '\n')
  } catch {
    // 诊断写不进去时静默
  }
}

/** 定位 $DSH_HOME（DSHM 同时认 DSH_HOME / DSHM_HOME 两个变量）。 */
function resolveHomeDir() {
  const candidates = [process.env.DSH_HOME, process.env.DSHM_HOME]
  for (const raw of candidates) {
    const text = String(raw === undefined ? '' : raw).trim()
    if (text === '' || !isAbsolute(text)) continue
    try {
      const dir = resolve(text)
      if (statSync(dir).isDirectory()) return dir
    } catch {
      // 试下一个来源
    }
  }
  return ''
}

/** 统一的 JSON 响应。 */
function json(res, statusCode, payload) {
  try {
    if (res.headersSent === true) {
      res.end()
      return
    }
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch {
    try {
      res.end()
    } catch {
      // 响应已经不可写：忽略。
    }
  }
}

/**
 * 同源校验：浏览器的 POST 一定带 Origin，非本机 Origin 一律拒绝；
 * 没有 Origin 的请求（curl / 脚本）放行，但仍受 CSRF 请求头约束。
 */
function isTrustedOrigin(req) {
  const origin = req.headers && req.headers.origin
  if (origin === undefined || origin === null || origin === '') return true
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (LOOPBACK_HOSTS.indexOf(parsed.hostname) >= 0) return true
  const host = req.headers && req.headers.host
  return typeof host === 'string' && host !== '' && parsed.host === host
}

/** 读 x-dsh-quit 头：非空即通过（自定义头会触发浏览器预检，跨站发不出来）。 */
function hasCsrfHeader(req) {
  const raw = req.headers && req.headers[CSRF_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return false
  return value.trim() !== ''
}

/**
 * 退出：结束 App 进程。
 *
 * 先把响应送回浏览器，再走 tryExit()：在 DSHM 里 Host 就是 App 进程内的主 node
 * 线程，结束它等于结束整个 App —— 表现就是“DSHM 直接消失回桌面”。
 */
function performExit(res) {
  if (runtime.pending !== null) {
    json(res, 409, {
      ok: false,
      error: 'busy',
      message: '上一次操作还在进行中',
      pending: runtime.pending.action,
    })
    return
  }
  const at = new Date().toISOString()
  runtime.pending = { action: 'quit', at }
  runtime.last = { action: 'quit', at, result: 'exiting' }
  diag('收到 quit 请求：' + EXIT_DELAY_MS + 'ms 后结束进程（pid=' + String(process.pid) + '）')

  json(res, 200, {
    ok: true,
    action: 'quit',
    exiting: true,
    delayMs: EXIT_DELAY_MS,
    message: '正在退出 dsh',
  })

  const timer = setTimeout(() => {
    runtime.timers.delete(timer)
    if (runtime.disposed) return
    tryExit()
  }, EXIT_DELAY_MS)
  runtime.timers.add(timer)
}


/**
 * 真正把进程结束掉。
 *
 * 真机实测（2026-10-26，v0.4.0）：这个嵌入环境里 `process.exit(0)` **不生效** ——
 * 日志写完“执行 process.exit(0)”后 Host 照旧活着（pid 不变）。所以按“越硬越靠前”
 * 的顺序依次尝试，每一步的成败都写进诊断日志：
 *
 *   1. `process.kill(pid, 'SIGKILL')` —— SIGKILL 不可捕获、不可忽略，正常内核下必死；
 *   2. `process.abort()` —— 走 libc abort()，进程立即终止（可能留下崩溃记录）；
 *   3. `process.exit(0)` —— 标准退出；
 *   4. 通过 koffi 直接调 libc `_exit(0)` —— 绕过 Node 的退出钩子，最硬的系统调用层。
 *
 * 四级都跑完还活着，说明宿主把这几条路全拦了，只能记录日志，让 App 侧（ArkTS）
 * 去提供退出入口。
 */
async function tryExit() {
  const pid = typeof process.pid === 'number' ? process.pid : 0
  diag('开始结束进程：pid=' + String(pid))
  try {
    diag('① 发送 SIGKILL 给自己')
    process.kill(pid, 'SIGKILL')
    diag('① SIGKILL 已发出（若内核送达，进程应当立即终止）')
  } catch (error) {
    diag('① SIGKILL 失败：' + errText(error))
  }
  try {
    diag('② 调用 process.abort()')
    process.abort()
    diag('② process.abort() 返回了（未终止）')
  } catch (error) {
    diag('② process.abort() 失败：' + errText(error))
  }
  try {
    diag('③ 调用 process.exit(0)')
    process.exit(0)
    diag('③ process.exit(0) 返回了（未终止）')
  } catch (error) {
    diag('③ process.exit(0) 失败：' + errText(error))
  }
  // ④ koffi → libc _exit(0)：绕开 Node 的退出路径，直接结束进程组。
  try {
    diag('④ 尝试通过 koffi 调用 libc _exit(0)')
    const mod = await import('koffi')
    const koffi = mod !== null && mod !== undefined && mod.default !== undefined ? mod.default : mod
    if (!koffi || typeof koffi.load !== 'function') {
      diag('④ koffi 已加载但缺少 load()')
    } else {
      const candidates = ['libc.so.6', 'libc.so', 'libc.musl-aarch64.so.1']
      for (const name of candidates) {
        try {
          const lib = koffi.load(name)
          const exitFn = lib.func('void _exit(int status)')
          diag('④ 已加载 ' + name + '，调用 _exit(0)')
          exitFn(0)
          diag('④ ' + name + ' 的 _exit(0) 返回了（未终止）')
        } catch (error) {
          diag('④ 加载/调用 ' + name + ' 失败：' + errText(error))
        }
      }
    }
  } catch (error) {
    diag('④ koffi 不可用：' + errText(error))
  }
  diag('四级退出手段全部无效：宿主拦截了进程退出，需要 App 侧（ArkTS）提供退出入口')
}

/** 只读诊断快照。 */
function stateSnapshot() {
  return {
    ok: true,
    name,
    version: VERSION,
    pid: typeof process.pid === 'number' ? process.pid : 0,
    node: typeof process.version === 'string' ? process.version : '',
    homeDir: runtime.homeDir,
    diagPath: runtime.diagPath,
    pending: runtime.pending,
    last: runtime.last,
    disposed: runtime.disposed,
    notes: [
      '退出（quit）：先回响应，再 SIGKILL → abort() → process.exit(0) → koffi/libc _exit(0) 四级结束进程',
      'POST 必须带 x-dsh-quit 请求头；服务端校验 Origin（只认本机同源）',
    ],
  }
}

/** 前缀路由的处理器。 */
function routeHandler(req, res) {
  let pathname = ''
  try {
    pathname = new URL(String(req.url === undefined ? '/' : req.url), 'http://127.0.0.1').pathname
  } catch {
    pathname = String(req.url === undefined ? '' : req.url)
  }
  if (pathname === ROUTE_STATE) {
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    json(res, 200, stateSnapshot())
    return
  }
  if (pathname === ROUTE_DIAG) {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (!isTrustedOrigin(req)) {
      json(res, 403, { ok: false, error: 'cross-origin-forbidden' })
      return
    }
    if (!hasCsrfHeader(req)) {
      json(res, 403, { ok: false, error: 'missing-csrf-header' })
      return
    }
    let body = ''
    if (typeof req.on === 'function') {
      req.on('data', (chunk) => {
        if (body.length < 2000) body += String(chunk)
      })
      req.on('end', () => {
        diag('客户端上报：' + body.slice(0, 600))
        json(res, 200, { ok: true })
      })
    } else {
      diag('客户端上报（无 body）')
      json(res, 200, { ok: true })
    }
    return
  }
  if (pathname === ROUTE_QUIT) {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (!isTrustedOrigin(req)) {
      json(res, 403, { ok: false, error: 'cross-origin-forbidden' })
      return
    }
    if (!hasCsrfHeader(req)) {
      json(res, 403, { ok: false, error: 'missing-csrf-header', message: '缺少 ' + CSRF_HEADER + ' 请求头' })
      return
    }
    performExit(res)
    return
  }
  json(res, 404, { ok: false, error: 'not-found' })
}

/** 插件入口。 */
export function apply(ctx) {
  try {
    if (!ctx || typeof ctx.effect !== 'function') {
      return
    }
    runtime.homeDir = resolveHomeDir()
    runtime.diagPath = runtime.homeDir === '' ? '' : join(runtime.homeDir, DIAG_FILE)
    diag('插件装载：v' + VERSION + ' home=' + (runtime.homeDir === '' ? '(未找到)' : runtime.homeDir))

    ctx.effect(() => {
      const cleanups = []
      try {
        const dispose = ctx.inject(['webServer'], (webCtx) => {
          const webServer = webCtx && webCtx.webServer
          if (!webServer || typeof webServer.register !== 'function') {
            diag('webServer.register 不可用：退出入口不可用（插件其余部分不受影响）')
            return
          }
          let off = null
          try {
            off = webServer.register({
              kind: 'prefix',
              path: ROUTE_PREFIX,
              handler: routeHandler,
            })
          } catch (error) {
            diag('路由注册失败：' + errText(error))
            return
          }
          diag('路由已注册：' + ROUTE_PREFIX + '/*')
          return () => {
            try {
              if (typeof off === 'function') off()
            } catch {
              // disposer 抛错不影响卸载
            }
          }
        })
        if (typeof dispose === 'function') cleanups.push(dispose)
      } catch (error) {
        diag('挂接 webServer 失败：' + errText(error))
      }

      return () => {
        runtime.disposed = true
        for (const timer of runtime.timers) {
          try {
            clearTimeout(timer)
          } catch {
            // ignore
          }
        }
        runtime.timers.clear()
        for (const cleanup of cleanups) {
          try {
            cleanup()
          } catch {
            // ignore
          }
        }
        cleanups.length = 0
        diag('插件卸载：路由与定时器已清理')
      }
    })
  } catch (error) {
    try {
      console.error('[dsh-quit] apply 失败：' + errText(error))
    } catch {
      // 连 console 都不可用时放弃
    }
  }
}
