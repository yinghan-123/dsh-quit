> **已停用（2026-10-26）**：重启功能已按用户要求去除（没有 App 源码、无法重新打包）。
> 本目录仅作存档，插件不会再写 `app-restart-request`。

# DSHM「一键重启 App」ArkTS 集成说明

> 目标：点插件面板里的「重启 dsh」→ App 关闭并**自动重新打开**（不是只停 dsh 服务）。
>
> 为什么必须改 App：插件跑在 App 内部的 node 里，能结束进程，但 HarmonyOS
> 没有“应用重启自己”的 API。只有 App 自己（ArkTS）才能在退出前把“启动自己”
> 的意图排进系统队列，退出后由系统执行。所以这条路是：**插件写请求文件 → App 轮询 → App 重启自己**。

---

## 1. 文件放置

```
platform/src/main/ets/notify/RestartBridge.ets   ← 本目录的 RestartBridge.ets
```

与现有 `KeepAliveBridge.ets` 同目录、同风格（轮询文件队列、全部 IO 包 try/catch、
不拖垮 Ability）。

## 2. EntryAbility 集成（3 处）

```ts
import { RestartBridge } from '../notify/RestartBridge';

export default class EntryAbility extends UIAbility {
  private restartBridge: RestartBridge | undefined = undefined;

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // …原有 onCreate…
    try {
      this.restartBridge = new RestartBridge(this.context);
      this.restartBridge.start();
    } catch (error) {
      console.error(`[EntryAbility] RestartBridge 启动失败：${error}`);
    }
  }

  onDestroy(): void {
    // …原有 onDestroy…
    try {
      this.restartBridge?.stop();
    } catch (error) {
      /* ignore */
    }
    this.restartBridge = undefined;
  }
}
```

> 只有 `onCreate` / `onDestroy` 两处必改。`onForeground` / `onBackground` 不需要动。

## 3. 打包安装

1. 把文件放好后重新打包 hap（DevEco 或你们的构建脚本）；
2. 安装到设备；
3. 打开一次 App，确认日志出现 `[RestartBridge] start：轮询重启请求`。

## 4. 插件侧配合（不用你改）

`dsh-quit` 的「重启 dsh」按钮（v0.6.0 起）做的是：

```
POST /dsh-quit/restart
  → 写 $DSH_HOME/app-restart-request
    {"source":"dsh-quit","action":"restart-app","at":"...","pid":12345}
  → 等 20 秒
    · 文件被 RestartBridge 消费（删掉）→ 视为已交给 App
    · 文件还在 → 说明 App 侧没装这个补丁，自动删掉并提示
```

## 5. 验证

| 检查 | 预期 |
| --- | --- |
| 点「重启 dsh」 | 面板提示“正在重启 App” |
| `$DSH_HOME/app-restart-request` | 出现后 1~2 秒内被删除 |
| `$DSH_HOME/app-restart.json` | `{"result":"wantAgent-triggered"}` 或 `startAbility-started` |
| 设备画面 | App 关闭后**自动重新打开** |
| 日志 | `[RestartBridge] wantAgent 已触发，准备 terminateSelf` → `terminateSelf：关闭当前 Ability` |

## 6. 风险与退路

- **系统可能不允许自启动**：`wantAgent` 的 START_ABILITY 在部分 HarmonyOS 版本上
  对“自己拉起自己”有约束，可能被静默忽略。表现：App 关闭了但没重新打开。
  桥会把结果写进 `app-restart.json`（`wantAgent-triggered` / `startAbility-started` / `failed`），
  据此判断是“系统忽略”还是“接口报错”。
- **如果被系统忽略**，退路是：把「重启」按钮改回“只关闭 App + 提示手动打开”
  （插件侧改一行即可），或者进一步研究系统级保活/拉起方案。
- **不要改成先 `terminateSelf` 再启动**：Ability 关闭后就没有代码机会去排队启动意图了。

## 7. 与现有桥的关系

| 桥 | 通道 | 作用 |
| --- | --- | --- |
| 现有 host-stop-request | `$DSH_HOME/host-stop-request` | 停 Host（App 会再拉起 Host） |
| KeepAliveBridge | `$DSH_HOME/keepalive/` | 后台保活 |
| **RestartBridge（本补丁）** | `$DSH_HOME/app-restart-request` | **重启整个 App** |

三者互不干扰，可以同时存在。
