/**
 * RestartBridge —— DSHM「一键重启 App」的 ArkTS 半部。
 *
 * 放置位置（客户端仓库）：`platform/src/main/ets/notify/RestartBridge.ets`
 * （与现有 `KeepAliveBridge.ets` 同目录，风格对齐）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 插件（Host 侧 node）能结束 App 进程，但**无法把 App 重新打开**：HarmonyOS
 * 没有让应用重启自己的 API，插件只能写文件。所以“一键重启”必须由 App 侧
 * 自己完成：收到请求 → 用 wantAgent 排一个“启动自己”的意图 → 再 terminateSelf。
 * 系统随后会按那个意图把应用重新拉起来。
 *
 * ── 协议（与插件 dsh-quit 的 Host 半部对齐）─────────────────────────────
 *   Host 插件写   $DSH_HOME/app-restart-request
 *                 { "source": "dsh-quit", "action": "restart-app", "at": "ISO", "pid": 123 }
 *   本桥写        $DSH_HOME/app-restart.json
 *                 { "lastRequestAt": "ISO", "lastAttemptAt": "ISO", "result": "...", "detail": "..." }
 *   本桥消费请求后会**删除** app-restart-request，避免二次触发。
 *
 * 目录：`$DSH_HOME` = `context.filesDir + "/dsh/home"`，与 Host 侧
 * `DSHM_HOME=/data/storage/el2/base/haps/entry/files/dsh/home` 是同一棵树
 * （两侧同 UID、同文件系统视图，与 `host-stop-request` / `keepalive/req` 同一手法）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * · 全部 IO / 系统调用包 try/catch：桥坏掉最多是“重启没生效”，绝不能拖垮 Ability。
 * · 同一时刻只处理一个请求（busy 标志）。
 * · 请求文件读完立刻删除：即使重启失败也不会反复触发。
 * · 不注册任何常驻监听，只用一个 1.5s 的轮询定时器（与 host-stop-request 同节拍）。
 *
 * ── 已知限制 ──────────────────────────────────────────────────────────────
 * · 如果系统（或 module.json 的 launchType）不允许应用自行拉起自己，
 *   wantAgent 可能被静默忽略 —— 表现是“App 关闭了但没重新打开”，等同退出。
 *   这时把结果记进 app-restart.json，便于排查。
 * · 触发前不要做重活：terminateSelf 会结束当前 Ability，之前的异步任务可能被截断。
 *
 * > **已停用（2026-10-26）**：重启功能已按用户要求去除（没有 App 源码、无法重新打包）。
 * > 本目录仅作存档，插件不会再写 `app-restart-request`。
 * 
 *
 */

import { common, wantAgent, Want, WantAgent } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

/** 日志域（hilog / console）。 */
const DOMAIN: number = 0xD5A2;
const TAG: string = 'RestartBridge';

/** 轮询节拍：与 host-stop-request 的 1.5s 对齐。 */
const POLL_MS: number = 1500;

/** 触发 wantAgent 之后、terminateSelf 之前的等待（给系统排队启动意图的时间）。 */
const TERMINATE_DELAY_MS: number = 600;

/** Host 写的重启请求。 */
interface RestartRequest {
  source?: string;
  action?: string;
  at?: string;
  pid?: number;
}

/** 本桥写的诊断快照。 */
interface RestartState {
  lastRequestAt: string;
  lastAttemptAt: string;
  result: string;
  detail: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeLog(message: string): void {
  try {
    console.info(`[${TAG}] ${message}`);
  } catch (error) {
    /* ignore */
  }
}

/**
 * 一键重启桥。一个 Ability 一份（EntryAbility.onCreate 里创建并 start，
 * onDestroy 里 stop）。
 */
export class RestartBridge {
  private context: common.UIAbilityContext;
  private requestPath: string;
  private statePath: string;

  /** 轮询定时器（ArkTS 里定时器返回 number）。 */
  private timer: number = -1;
  /** 同一时刻只处理一个请求。 */
  private busy: boolean = false;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.requestPath = `${context.filesDir}/dsh/home/app-restart-request`;
    this.statePath = `${context.filesDir}/dsh/home/app-restart.json`;
  }

  /** 开始轮询。重复调用安全。 */
  start(): void {
    if (this.timer >= 0) {
      return;
    }
    safeLog('start：轮询重启请求');
    this.timer = setInterval(() => {
      this.tick();
    }, POLL_MS);
    this.tick();
  }

  /** 停止轮询。 */
  stop(): void {
    if (this.timer >= 0) {
      clearInterval(this.timer);
      this.timer = -1;
    }
  }

  /** 一次轮询：有请求就消费掉并尝试重启。 */
  private tick(): void {
    if (this.busy) {
      return;
    }
    try {
      if (!fs.accessSync(this.requestPath)) {
        return;
      }
      const raw = this.readText(this.requestPath);
      this.busy = true;
      // 先删请求：即使后面失败，也不会反复触发。
      this.removeRequest();
      this.attemptRestart(raw);
    } catch (error) {
      safeLog(`tick 失败：${this.errorText(error as Object)}`);
    }
  }

  /**
   * 尝试重启：wantAgent 排一个 START_ABILITY 意图 → 等一会儿 → terminateSelf。
   *
   * 顺序不能用反：先 terminateSelf 就再没有代码机会去排队启动意图了。
   */
  private async attemptRestart(raw: string): Promise<void> {
    const requestAt = this.parseRequestAt(raw);
    const want: Want = {
      bundleName: this.context.abilityInfo.bundleName,
      abilityName: this.context.abilityInfo.name,
    };
    try {
      const info: wantAgent.WantAgentInfo = {
        wants: [want],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG],
      };
      const agent: WantAgent = await wantAgent.getWantAgent(info);
      await wantAgent.trigger(agent, {});
      this.writeState({
        lastRequestAt: requestAt,
        lastAttemptAt: nowIso(),
        result: 'wantAgent-triggered',
        detail: '已排队启动意图，等待 terminateSelf',
      });
      safeLog('wantAgent 已触发，准备 terminateSelf');
      this.scheduleTerminate();
    } catch (error) {
      // 备路：直接 startAbility（部分系统版本对 wantAgent 自启动更严格）。
      const detail = this.errorText(error as Object);
      safeLog(`wantAgent 失败，改用 startAbility：${detail}`);
      try {
        await this.context.startAbility(want);
        this.writeState({
          lastRequestAt: requestAt,
          lastAttemptAt: nowIso(),
          result: 'startAbility-started',
          detail,
        });
        this.scheduleTerminate();
      } catch (secondError) {
        const secondDetail = this.errorText(secondError as Object);
        safeLog(`startAbility 也失败：${secondDetail}`);
        this.writeState({
          lastRequestAt: requestAt,
          lastAttemptAt: nowIso(),
          result: 'failed',
          detail: `${detail} | ${secondDetail}`,
        });
        this.busy = false;
      }
    }
  }

  /** 稍等片刻再关闭自己，给系统把启动意图排进队列的机会。 */
  private scheduleTerminate(): void {
    setTimeout(() => {
      try {
        safeLog('terminateSelf：关闭当前 Ability');
        this.context.terminateSelf();
      } catch (error) {
        safeLog(`terminateSelf 失败：${this.errorText(error as Object)}`);
      } finally {
        this.busy = false;
      }
    }, TERMINATE_DELAY_MS);
  }

  /** 读请求文件全文。 */
  private readText(path: string): string {
    try {
      const stat = fs.statSync(path);
      const buffer = new ArrayBuffer(stat.size);
      const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
      try {
        fs.readSync(file.fd, buffer);
      } finally {
        fs.closeSync(file);
      }
      const decoder = new util.TextDecoder();
      return decoder.decodeToString(new Uint8Array(buffer));
    } catch (error) {
      safeLog(`读请求失败：${this.errorText(error as Object)}`);
      return '';
    }
  }

  /** 删掉请求文件（失败忽略）。 */
  private removeRequest(): void {
    try {
      fs.unlinkSync(this.requestPath);
    } catch (error) {
      /* 已经被删 / 没有权限：忽略 */
    }
  }

  /** 解析请求里的时间戳（只用于诊断，解析失败不影响重启）。 */
  private parseRequestAt(raw: string): string {
    try {
      const parsed = JSON.parse(raw) as RestartRequest;
      if (typeof parsed.at === 'string' && parsed.at.length > 0) {
        return parsed.at;
      }
    } catch (error) {
      /* 非 JSON：忽略 */
    }
    return nowIso();
  }

  /** 写诊断快照（失败忽略）。 */
  private writeState(state: RestartState): void {
    try {
      const text = JSON.stringify(state);
      const file = fs.openSync(this.statePath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, text);
      } finally {
        fs.closeSync(file);
      }
    } catch (error) {
      safeLog(`写状态失败：${this.errorText(error as Object)}`);
    }
  }

  /** 把任意错误压成一行文本（ArkTS 严格模式下 catch 变量不能裸传给 Object 形参）。 */
  private errorText(error: Object): string {
    try {
      const anyError = error as Record<string, Object>;
      if (anyError !== null && anyError !== undefined) {
        const message = anyError['message'];
        if (typeof message === 'string') {
          return message;
        }
        const code = anyError['code'];
        if (typeof code === 'string' || typeof code === 'number') {
          return `${code}`;
        }
      }
      return `${error}`;
    } catch (inner) {
      return 'unknown-error';
    }
  }
}
