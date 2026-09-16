/**
 * Python/Win32 电脑操作 Provider：把 `ctx.computer` 实现在宿主桌面上。
 *
 * 为什么是外部 Python 进程而不是原生插件：Node 没有内置的 Win32 绑定，
 * 而 ctypes 是 CPython 标准库的一部分，桌面控制因此可以零第三方依赖、
 * 零编译地完成。Provider 只依赖标准库脚本 + 一个解释器，
 * 换成 macOS/Linux 实现时只需替换本包，seam 与工具不动。
 *
 * 与执行世界的关系：桌面动作必须落在**用户真实看到的桌面**上，
 * 因此这里刻意不经过 `ctx.subprocess`（那个 seam 可能指向远程沙箱），
 * 而是直接在宿主上启动解释器。这是本包唯一越出执行世界的边界，
 * 也是它必须由用户显式启用（暴露给模型）的原因。
 *
 * @module @deepseek-ai/dsh-computer-python
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ComputerError, ComputerUse } from '@deepseek-ai/dsh-computer'
import type {
  ComputerAvailability,
  ComputerCallOptions,
  ComputerClickInput,
  ComputerDisplay,
  ComputerDragInput,
  ComputerDragResult,
  ComputerErrorCode,
  ComputerKeyInput,
  ComputerPoint,
  ComputerScreenshot,
  ComputerScrollInput,
  ComputerTypeInput,
} from '@deepseek-ai/dsh-computer'
import { resolveConfig } from './config.ts'
import type { Config, ResolvedConfig } from './config.ts'

export type { Config } from './config.ts'
export { resolveConfig, DEFAULT_TIMEOUT_MS } from './config.ts'

/** 请求脚本的协议版本；脚本与 Provider 必须同时升级。 */
export const RUNTIME_PROTOCOL = 1

/** 探测到的解释器调用方式：可执行文件加上它需要的固定前导参数。 */
interface Interpreter {
  readonly command: string
  readonly leadingArgs: readonly string[]
}

/** 候选解释器，按顺序尝试。`py` 是 Windows 的 Python Launcher。 */
const INTERPRETER_CANDIDATES: readonly Interpreter[] = [
  { command: 'python', leadingArgs: [] },
  { command: 'python3', leadingArgs: [] },
  { command: 'py', leadingArgs: ['-3'] },
]

/** 脚本相对包根的位置，编译产物与源码模式下都成立。 */
const SCRIPT_URL = new URL('../runtime/computer_agent.py', import.meta.url)

declare module '@deepseek-ai/cordis' {
  interface Context {
    computer: ComputerUse
  }
}

/** 脚本对一次请求的回答。 */
interface RuntimeReply {
  ok: boolean
  action?: unknown
  error?: unknown
  code?: unknown
  [key: string]: unknown
}

/** 把脚本返回的稳定错误码收敛到本能力声明的集合。 */
function toErrorCode(value: unknown): ComputerErrorCode {
  const known: readonly ComputerErrorCode[] = [
    'UNSUPPORTED_PLATFORM', 'UNAVAILABLE', 'INVALID_REQUEST',
    'CAPTURE_FAILED', 'INPUT_FAILED', 'RUNTIME_FAILED', 'TIMEOUT', 'ABORTED',
  ]
  return typeof value === 'string' && (known as readonly string[]).includes(value)
    ? value as ComputerErrorCode
    : 'RUNTIME_FAILED'
}

/** 读取显示器几何所需的最小字段集；缺失即视为脚本版本不匹配。 */
function numberField(reply: RuntimeReply, field: string, action: string): number {
  const value = reply[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ComputerError(
      `电脑操作运行时对 ${action} 的回答缺少数字字段 ${field}；脚本与 Provider 版本可能不一致`,
      'RUNTIME_FAILED',
    )
  }
  return value
}

/** 校验一组数字字段存在且有限，用于只做探测、不消费数值的路径。 */
function assertNumberFields(reply: RuntimeReply, fields: readonly string[], action: string): void {
  for (const field of fields) numberField(reply, field, action)
}

/**
 * Python/Win32 电脑操作 Provider。
 *
 * 配置见 {@link Config}。服务在挂载时并不启动任何进程，第一次真正调用
 * （或第一次 {@link available}）才做解释器探测，因此没有桌面环境的部署
 * 不会因为多挂一个插件而付出代价。
 */
export class PythonComputerUse extends ComputerUse {
  readonly provider = 'python-win32'

  private readonly config: ResolvedConfig

  /** 脚本的绝对路径；构造时解析一次，之后不再依赖 import.meta 的位置。 */
  private readonly scriptPath: string

  /** 探测结果缓存；`undefined` 表示尚未探测。 */
  private probe: Promise<ComputerAvailability> | undefined

  /** 解释器探测缓存；失败结论同样缓存，避免每次调用重复尝试三个候选。 */
  private interpreterCache: Promise<Interpreter> | undefined

  /** 截图临时目录；第一次截图时惰性创建，插件卸载时清理。 */
  private scratchDir: Promise<string> | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    this.scriptPath = fileURLToPath(SCRIPT_URL)
    ctx.effect(() => () => {
      const pending = this.scratchDir
      this.scratchDir = undefined
      if (pending === undefined) return
      // 卸载时清理截图残留；失败只记录，不影响卸载。
      void pending.then(dir => rm(dir, { recursive: true, force: true })).catch(() => undefined)
    }, 'dsh-computer-python: 清理截图临时目录')
  }

  /** 当前生效的解释器；未配置时按候选顺序探测。 */
  private async resolveInterpreter(): Promise<Interpreter> {
    const configured = this.config.pythonPath
    if (configured !== '') {
      return { command: configured, leadingArgs: [] }
    }
    const failures: string[] = []
    for (const candidate of INTERPRETER_CANDIDATES) {
      try {
        const reply = await this.invoke(candidate, { action: 'display' }, undefined, 15_000)
        assertNumberFields(reply, ['width', 'height', 'originX', 'originY'], 'display')
        return candidate
      } catch (error: unknown) {
        failures.push(`${candidate.command}${candidate.leadingArgs.join(' ')}: ${describe(error)}`)
      }
    }
    throw new ComputerError(
      `电脑操作需要一个可用的 CPython 解释器，但候选 ${INTERPRETER_CANDIDATES.map(item => item.command).join(' / ')} 都不可用：${failures.join('；')}。`
      + '请安装 Python 3，或把解释器绝对路径写入配置项 computer-python.pythonPath。',
      'UNAVAILABLE',
    )
  }

  /**
   * 启动一次脚本调用，把请求写进 stdin（避免命令行长度与换行转义问题），
   * 读取唯一一行 JSON 回答。
   *
   * @param interpreter - 解释器与固定前导参数。
   * @param request - 动作请求，序列化成一行 JSON。
   * @param signal - 调用方取消信号。
   * @param timeoutMs - 本次调用的超时。
   * @returns 脚本回答（已解析）。
   */
  private async invoke(
    interpreter: Interpreter,
    request: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<RuntimeReply> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const child = spawn(
      interpreter.command,
      [...interpreter.leadingArgs, this.scriptPath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })

    const settle = new Promise<void>((resolve, reject) => {
      child.once('error', (error: NodeJS.ErrnoException) => {
        reject(new ComputerError(
          error.code === 'ENOENT'
            ? `找不到 Python 解释器 ${interpreter.command}`
            : `启动 Python 解释器失败：${error.message}`,
          error.code === 'ENOENT' ? 'UNAVAILABLE' : 'RUNTIME_FAILED',
          { cause: error },
        ))
      })
      child.once('close', () => { resolve() })
    })

    const onAbort = (): void => {
      // 子进程只做一次动作，直接杀掉即可；等待 close 由 settle 负责。
      child.kill()
    }
    combined.addEventListener('abort', onAbort, { once: true })

    try {
      child.stdin.end(`${JSON.stringify(request)}\n`)
      await settle
    } finally {
      combined.removeEventListener('abort', onAbort)
    }

    if (combined.aborted) {
      throw new ComputerError(
        signal?.aborted === true ? '电脑操作被取消' : `电脑操作超过 ${timeoutMs}ms 未完成`,
        signal?.aborted === true ? 'ABORTED' : 'TIMEOUT',
      )
    }

    const line = stdout.trim().split('\n').filter(part => part.trim() !== '').at(-1)
    if (line === undefined) {
      throw new ComputerError(
        `Python 运行时没有返回结果${stderr.trim() === '' ? '' : `：${stderr.trim().slice(0, 500)}`}`,
        'RUNTIME_FAILED',
      )
    }
    let reply: RuntimeReply
    try {
      reply = JSON.parse(line) as RuntimeReply
    } catch (error: unknown) {
      throw new ComputerError(
        `Python 运行时返回了非 JSON 内容：${line.slice(0, 300)}`,
        'RUNTIME_FAILED',
        { cause: error },
      )
    }
    if (!reply.ok) {
      throw new ComputerError(
        typeof reply.error === 'string' ? reply.error : '电脑操作失败（运行时未给出原因）',
        toErrorCode(reply.code),
      )
    }
    return reply
  }

  /** 探测一次并缓存；解释器缺失时缓存的是失败结论，避免每次调用都重试。 */
  private async interpreter(): Promise<Interpreter> {
    this.interpreterCache ??= this.resolveInterpreter()
    return await this.interpreterCache
  }

  /** 惰性创建截图临时目录。 */
  private async scratch(): Promise<string> {
    this.scratchDir ??= mkdtemp(join(tmpdir(), 'dsh-computer-'))
    return await this.scratchDir
  }

  /** 统一入口：解析解释器、发请求、按超时收口。 */
  private async call(
    request: Record<string, unknown>,
    options?: ComputerCallOptions,
  ): Promise<RuntimeReply> {
    const interpreter = await this.interpreter()
    return await this.invoke(interpreter, request, options?.signal, this.config.timeoutMs)
  }

  async available(options?: ComputerCallOptions): Promise<ComputerAvailability> {
    this.probe ??= this.probeAvailability(options)
    return await this.probe
  }

  private async probeAvailability(options?: ComputerCallOptions): Promise<ComputerAvailability> {
    if (process.platform !== 'win32') {
      return {
        available: false,
        provider: this.provider,
        platform: process.platform,
        reason: `电脑操作目前只实现了 Windows 桌面（win32），当前宿主是 ${process.platform}。`,
      }
    }
    try {
      const reply = await this.call({ action: 'display' }, options)
      assertNumberFields(reply, ['width', 'height', 'originX', 'originY'], 'display')
      return { available: true, provider: this.provider, platform: process.platform }
    } catch (error: unknown) {
      return {
        available: false,
        provider: this.provider,
        platform: process.platform,
        reason: describe(error),
      }
    }
  }

  async display(options?: ComputerCallOptions): Promise<ComputerDisplay> {
    const reply = await this.call({ action: 'display' }, options)
    return {
      originX: numberField(reply, 'originX', 'display'),
      originY: numberField(reply, 'originY', 'display'),
      width: numberField(reply, 'width', 'display'),
      height: numberField(reply, 'height', 'display'),
      primaryWidth: numberField(reply, 'primaryWidth', 'display'),
      primaryHeight: numberField(reply, 'primaryHeight', 'display'),
    }
  }

  async screenshot(options?: ComputerCallOptions): Promise<ComputerScreenshot> {
    const scratch = await this.scratch()
    // 每次截图用独立文件名：并发截图（两个会话同时看屏幕）不会互相覆盖。
    const target = join(scratch, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.png`)
    try {
      const reply = await this.call({ action: 'screenshot', out: target }, options)
      const data = await readFile(target)
      return {
        originX: numberField(reply, 'originX', 'screenshot'),
        originY: numberField(reply, 'originY', 'screenshot'),
        width: numberField(reply, 'width', 'screenshot'),
        height: numberField(reply, 'height', 'screenshot'),
        data: new Uint8Array(data),
      }
    } finally {
      await rm(target, { force: true }).catch(() => undefined)
    }
  }

  async pointer(options?: ComputerCallOptions): Promise<ComputerPoint> {
    const reply = await this.call({ action: 'pointer' }, options)
    return { x: numberField(reply, 'x', 'pointer'), y: numberField(reply, 'y', 'pointer') }
  }

  async move(point: ComputerPoint, options?: ComputerCallOptions): Promise<ComputerPoint> {
    const reply = await this.call({ action: 'move', x: point.x, y: point.y }, options)
    return { x: numberField(reply, 'x', 'move'), y: numberField(reply, 'y', 'move') }
  }

  async click(
    input: ComputerClickInput,
    options?: ComputerCallOptions,
  ): Promise<ComputerPoint & { button: string; clicks: number }> {
    const reply = await this.call({
      action: 'click',
      ...input.x === undefined ? {} : { x: input.x },
      ...input.y === undefined ? {} : { y: input.y },
      ...input.button === undefined ? {} : { button: input.button },
      ...input.clicks === undefined ? {} : { clicks: input.clicks },
    }, options)
    return {
      x: numberField(reply, 'x', 'click'),
      y: numberField(reply, 'y', 'click'),
      button: typeof reply.button === 'string' ? reply.button : input.button ?? 'left',
      clicks: typeof reply.clicks === 'number' ? reply.clicks : input.clicks ?? 1,
    }
  }

  async drag(input: ComputerDragInput, options?: ComputerCallOptions): Promise<ComputerDragResult> {
    const reply = await this.call({
      action: 'drag',
      fromX: input.fromX,
      fromY: input.fromY,
      toX: input.toX,
      toY: input.toY,
      ...input.button === undefined ? {} : { button: input.button },
      ...input.durationMs === undefined ? {} : { durationMs: input.durationMs },
    }, options)
    return {
      fromX: numberField(reply, 'fromX', 'drag'),
      fromY: numberField(reply, 'fromY', 'drag'),
      toX: numberField(reply, 'toX', 'drag'),
      toY: numberField(reply, 'toY', 'drag'),
      button: typeof reply.button === 'string' ? reply.button : input.button ?? 'left',
    }
  }

  async typeText(
    input: ComputerTypeInput,
    options?: ComputerCallOptions,
  ): Promise<{ characters: number }> {
    const reply = await this.call({
      action: 'type',
      text: input.text,
      ...input.x === undefined ? {} : { x: input.x },
      ...input.y === undefined ? {} : { y: input.y },
    }, options)
    return { characters: numberField(reply, 'characters', 'type') }
  }

  async key(input: ComputerKeyInput, options?: ComputerCallOptions): Promise<{ keys: string[] }> {
    const reply = await this.call({
      action: 'key',
      keys: [...input.keys],
      ...input.x === undefined ? {} : { x: input.x },
      ...input.y === undefined ? {} : { y: input.y },
    }, options)
    if (!Array.isArray(reply.keys)) {
      throw new ComputerError('电脑操作运行时对 key 的回答缺少 keys 数组', 'RUNTIME_FAILED')
    }
    return { keys: reply.keys.filter((item): item is string => typeof item === 'string') }
  }

  async scroll(
    input: ComputerScrollInput,
    options?: ComputerCallOptions,
  ): Promise<ComputerPoint & { deltaX: number; deltaY: number }> {
    const reply = await this.call({
      action: 'scroll',
      ...input.x === undefined ? {} : { x: input.x },
      ...input.y === undefined ? {} : { y: input.y },
      ...input.deltaX === undefined ? {} : { deltaX: input.deltaX },
      ...input.deltaY === undefined ? {} : { deltaY: input.deltaY },
    }, options)
    return {
      x: numberField(reply, 'x', 'scroll'),
      y: numberField(reply, 'y', 'scroll'),
      deltaX: numberField(reply, 'deltaX', 'scroll'),
      deltaY: numberField(reply, 'deltaY', 'scroll'),
    }
  }
}

/** 把任意错误压成一行可展示文本。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default PythonComputerUse
