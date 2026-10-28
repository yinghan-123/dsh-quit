# dsh-quit（退出）

> GitHub：https://github.com/yinghan-123/dsh-quit · 一行安装：`pnpm add github.com/yinghan-123/dsh-quit`

> DSHM 端侧的退出入口：在**侧栏底部的账户菜单**（头像 / ⋯ 按钮弹出的「设置 / 联系我们 /
> 登录或退出登录」那个菜单）里注入一行「退出 dsh」，确认后 **DSHM 直接关掉、回到桌面**，
> 不用再去系统多任务里把应用划掉。

- 版本：`0.8.2`
- 位置：账户菜单（官方账户插件的 `settings.launcher`，**DOM 注入一行**）+ `shell.overlay`（确认面板）
- 接口：`POST /dsh-quit/quit`、`GET /dsh-quit/state`
- 依赖：无（客户端只用平台 `react` + `ctx.slots` + 原生 DOM；缺 React 时降级为惰性元素描述）

> **重启功能已按用户要求去除。** 直接原因：一键重启 App（关闭 + 自动重开）需要改
> App 侧 ArkTS，而当前没有 App 源码、无法重新打包；只停 Host 的“重启”又会让界面
> 半死，用户不要。所以插件只保留「退出」。

---

## 1. 它做了什么

点「退出 dsh」→ 确认 → Host 先把 HTTP 响应送回浏览器 → **150 ms 后开始结束进程**。

DSHM 把 dsh Host 跑在 **App 进程内的主 node 线程**上（`$DSH_HOME/host-ready.json` 的 `pid`
是 App 进程号，日志里的 `js-tid` 是 node 线程号）。结束这个线程 = **整个 App 结束**，
表现就是“DSHM 直接消失回桌面”，和你在多任务里划掉它等效。下次打开应用时 Host 重新启动。

### 为什么是四级退出

真机实测（2026-10-26，v0.4.0）：`process.exit(0)` 在这个嵌入环境里**不生效** ——
日志写完“执行 process.exit(0)”后 Host 照旧活着（pid 不变）。所以按“越硬越靠前”依次尝试，
每一级的成败都写进 `$DSH_HOME/dsh-quit.log`：

1. `process.kill(pid, 'SIGKILL')` —— 不可捕获、不可忽略；
2. `process.abort()` —— 走 libc abort()；
3. `process.exit(0)` —— 标准退出；
4. koffi → `libc.so.6` / `libc.so` / `libc.musl-aarch64.so.1` 的 `_exit(0)` —— 绕过 Node 的退出钩子。

四级都失败会写一行“四级退出手段全部无效”，说明宿主把退出全拦了，需要 App 侧（ArkTS）配合。

## 2. 会中断什么

- 正在进行的模型对话会中断；
- 会话日志是逐事件落盘的，**已落盘的内容不会丢**，中断的 turn 会断在那里；
- 后台任务（job）随之停止。

所以确认面板里会先问一次。

## 3. 为什么入口是 DOM 注入

那个账户菜单由官方账户插件（`dsh-client-ui-settings-account`）的 `AccountMenu` 渲染，
菜单项（设置 / 联系我们 / 登录 / 退出登录）**写死在它的 `items` 数组里**，平台**没有**
提供“往这个菜单加一条”的 slot。`settings.launcher` 座位是 single，占用它就是**替换**整个
账户入口 —— 会丢掉头像、余额、登录/退出登录，代价太大。

所以客户端半部用**只追加、不改写**的注入：

1. `MutationObserver` 盯 `document.body`；
2. 出现 `[role="menu"]` 且文本命中两个以上账户菜单特征词（设置 / 联系我们 / 登录 /
   退出登录 / Settings / Contact / Sign in / Sign out）→ 认定为账户菜单；
3. 克隆菜单最后一项作为**原生外壳**（行高、内边距、hover、字体全部与官方一致），然后：
   - 图标换成同尺寸的 stroke 电源符号（颜色跟随 currentColor）；
   - 文字与图标用官方语义危险色 `--dsw-alias-state-error-primary`；
   - 在它上方补一条 `--dsw-alias-border-l2` 分隔线；
4. 把这些插到原项之后；点击 → 打开我们自己的确认面板（`shell.overlay`）。

**失败模式是安全的**：找不到菜单、结构对不上、官方升级改了 DOM —— 都只是“不注入”，
官方菜单原样可用，不会坏界面。React 重渲染冲掉注入节点时，下一轮观察会补回来（幂等）。

## 4. 安装（DSHM 端侧）

**一行安装**（DSHM 端侧的 `pnpm` 是 Host 布置的假壳，`add` 会走安装队列并同步返回结果）：

```bash
pnpm add github.com/yinghan-123/dsh-quit
```

或手工落盘：

1. 把整个 `dsh-quit/` 目录复制到 profile 的 `node_modules`：
   ```
   $DSH_HOME/profiles/ondevice/node_modules/dsh-quit/
   ```
   （`$DSH_HOME` 本机为 `/data/storage/el2/base/haps/phone/files/dsh/home`）
2. 在 `$DSH_HOME/profiles/ondevice/package.json` 里：
   - `dependencies` 追加 `"dsh-quit": "github:yinghan-123/dsh-quit"`（或本机源码路径 `file:<你的目录>`）
   - `dsh.profile.bundles` 追加 `"dsh-quit"`
3. **重启一次 DSHM 应用**（客户端半部要重新扫描 `dsh.client` 声明）。

更新已有安装：直接用 `deploy.py`（备份 + 覆盖 + 校验，可重复执行）：
```bash
python deploy.py
```

### 回滚

- 从 `dsh.profile.bundles` 删掉 `dsh-quit`（和 `dependencies` 那一行），重启应用；
- 或直接删掉 `node_modules/dsh-quit/` 目录；
- 本插件只新增文件，不改任何官方装载行。

## 5. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/dsh-quit/quit` | 回响应后 150 ms 开始四级退出 |
| `GET` | `/dsh-quit/state` | 只读诊断：pid、home、pending、上次动作 |

POST 必须带请求头 `x-dsh-quit: 1`（任何非空值即可）。服务端另外校验 Origin：
带 `Origin` 的请求必须来自本机（`127.0.0.1` / `localhost` / `::1`，或与 `Host` 头一致）；
无法解析的 Origin 一律拒绝；无 Origin（curl/脚本）放行。自定义头会触发浏览器预检，
跨站页面无法静默发出这种请求。

```bash
curl -s http://127.0.0.1:3120/dsh-quit/state
curl -s -X POST -H 'x-dsh-quit: 1' http://127.0.0.1:3120/dsh-quit/quit
```

## 6. 诊断

- `GET /dsh-quit/state`：pid、`$DSH_HOME`、`pending`、`last`；
- `$DSH_HOME/dsh-quit.log`：逐行诊断（装载、路由、收到请求、退出四级各自的成败）；
- 菜单里有没有 `[data-dsh-quit-item]`：判断注入是否命中。

## 7. 自检

本机不能跑 node，仓库里带一个 Python 词法/结构检查器：

```bash
python check.py .          # 端侧可直接用 Agent 的 python 工具跑
```

它检查：JS 词法（字符串/模板/注释/括号平衡）、必需要素（导出、注入器、座位名、
四条退出手段、CSRF 头、卸载清理）、禁止项（重启路由/重启请求文件、子进程、外联、
`eval`、在 `apply` 里调 hook、再占用侧栏底部座位）、`package.json` 与
`cordis.patch.yml` 的结构。

## 8. 已知边界

- **这是“结束进程”式的退出**：不是点窗口关闭按钮走 App 的 `onDestroy` 收尾流程；
  这条路在 DSHM 里是唯一能让 App 真正消失的方式。
- **DSHM 里不存在“App 退出但核心还活着”**：核心就在 App 进程里，两者同生共死。
- **一键重启 App 需要 App 源码**：插件只能结束进程，无法重新拉起 App；
  没有源码就改不了 ArkTS，因此该功能已去除。
- **DOM 注入是官方无扩展点下的折中**：官方升级改了账户菜单结构 → 注入静默失效
  （只是“没有这一行”，不会坏界面）。
- **注入项不在 React 的菜单项列表里**：鼠标/触摸点击正常，键盘方向键导航不会聚焦到它。
- **只在 Web 界面生效**：不提供 CLI / 其它前端入口。
