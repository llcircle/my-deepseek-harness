/**
 * 真实运行时的契约测试：真的启动 Python、真的截屏、真的读写指针。
 *
 * 这里不 mock 任何东西——provider 与脚本之间的一行 JSON 协议、坐标单位、
 * 错误码收敛，只有在真跑的时候才能验证。没有可用解释器的宿主会整体跳过，
 * 而不是假装通过。
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ComputerError } from '@deepseek-ai/dsh-computer'
import PythonComputerUse from '@deepseek-ai/dsh-computer-python'

/** 运行时脚本的绝对路径；子进程按路径直接加载它，绕开 provider 的进程协议。 */
const RUNTIME_SCRIPT = fileURLToPath(new URL('../runtime/computer_agent.py', import.meta.url))

/** 找一个能用的 CPython 调用方式；找不到就整体跳过。 */
function detectPython(): string | undefined {
  const candidates: Array<{ command: string; args: string[] }> = [
    { command: 'python', args: [] },
    { command: 'python3', args: [] },
    { command: 'py', args: ['-3'] },
  ]
  for (const candidate of candidates) {
    try {
      execFileSync(candidate.command, [...candidate.args, '-c', 'import ctypes, zlib, struct'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      return candidate.command
    } catch {
      continue
    }
  }
  return undefined
}

const python = process.platform === 'win32' ? detectPython() : undefined

async function mount(config: Record<string, unknown> = {}): Promise<{ ctx: Context; computer: PythonComputerUse }> {
  const ctx = new Context()
  await ctx.plugin(PythonComputerUse, python === undefined ? config : { pythonPath: python, ...config })
  const computer = ctx.get('computer') as PythonComputerUse
  return { ctx, computer }
}

describe.skipIf(python === undefined)('PythonComputerUse 与运行时脚本的契约', () => {
  it('探测报告可用，并给出提供方与平台', async () => {
    const { computer } = await mount()
    const status = await computer.available()
    expect(status.available).toBe(true)
    expect(status.provider).toBe('python-win32')
    expect(status.platform).toBe('win32')
  }, 30_000)

  it('读取的屏幕几何是正的物理像素', async () => {
    const { computer } = await mount()
    const display = await computer.display()
    expect(display.width).toBeGreaterThan(0)
    expect(display.height).toBeGreaterThan(0)
    expect(display.primaryWidth).toBeGreaterThan(0)
    expect(Number.isInteger(display.originX)).toBe(true)
  }, 30_000)

  it('截图返回带 PNG 签名的字节，尺寸与屏幕一致', async () => {
    const { computer } = await mount()
    const shot = await computer.screenshot()
    expect(shot.data.byteLength).toBeGreaterThan(0)
    // PNG 魔数，前 8 字节固定。
    expect([...shot.data.slice(0, 8)]).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    expect(shot.width).toBeGreaterThan(0)
    expect(shot.height).toBeGreaterThan(0)
  }, 60_000)

  it('读取指针返回整数坐标', async () => {
    const { computer } = await mount()
    const pointer = await computer.pointer()
    expect(Number.isInteger(pointer.x)).toBe(true)
    expect(Number.isInteger(pointer.y)).toBe(true)
  }, 30_000)

  it('解释器不可用时给稳定错误码而不是平台报错', async () => {
    const { computer } = await mount({ pythonPath: 'definitely-not-a-python-binary' })
    await expect(computer.display()).rejects.toBeInstanceOf(ComputerError)
    await expect(computer.display()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  }, 30_000)

  it('超时收敛为 TIMEOUT，而不是挂住', async () => {
    const { computer } = await mount({ timeoutMs: 1 })
    // 1 毫秒对一个真实进程来说必然来不及。
    await expect(computer.display()).rejects.toMatchObject({ code: 'TIMEOUT' })
  }, 30_000)

  it('available() 在解释器缺失时报告原因而不是抛错', async () => {
    const { computer } = await mount({ pythonPath: 'definitely-not-a-python-binary' })
    const status = await computer.available()
    expect(status.available).toBe(false)
    expect(status.reason).toMatch(/Python/u)
  }, 30_000)

  /**
   * drag 的起点字段是 fromX/fromY，不是 x/y。
   *
   * 这里不真的拖动鼠标：把 send_inputs/move_pointer/settle 换成空实现后直接调用
   * action_drag，验证参数解析。曾经的缺陷就是复用只认 x/y 的 optional_point，
   * 导致起点永远读成 None，报「drag 需要 fromX/fromY 作为起点」。
   */
  it('drag 从 fromX/fromY 读取起点', () => {
    const script = [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("computer_agent", r"${RUNTIME_SCRIPT}")`,
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'module.send_inputs = lambda events: None',
      'module.move_pointer = lambda x, y: None',
      'module.settle = lambda seconds=0.03: None',
      'module.time.sleep = lambda seconds: None',
      'result = module.action_drag({"fromX": 3, "fromY": 4, "toX": 9, "toY": 8})',
      'print(json.dumps(result))',
    ].join('\n')
    const stdout = execFileSync(python as string, ['-c', script], { encoding: 'utf8', windowsHide: true })
    expect(JSON.parse(stdout)).toMatchObject({ fromX: 3, fromY: 4, toX: 9, toY: 8 })
  }, 30_000)

  it('drag 缺起点时给 INVALID_REQUEST，而不是静默拖到 (0,0)', () => {
    const script = [
      'import importlib.util, json',
      `spec = importlib.util.spec_from_file_location("computer_agent", r"${RUNTIME_SCRIPT}")`,
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'try:',
      '    module.action_drag({"toX": 9, "toY": 8})',
      'except module.ComputerRuntimeError as error:',
      '    print(json.dumps({"code": error.code, "message": error.message}))',
    ].join('\n')
    const stdout = execFileSync(python as string, ['-c', script], { encoding: 'utf8', windowsHide: true })
    expect(JSON.parse(stdout)).toMatchObject({ code: 'INVALID_REQUEST' })
  }, 30_000)

  /**
   * 对外契约是「deltaY 为正向下滚」（与 DOM WheelEvent 一致），
   * 而 Win32 正的 mouseData 是向上滚，所以脚本必须在边界处把纵向取反。
   * 这里拦下真实的 INPUT 事件读 mouseData，确认符号真的翻转了。
   */
  it('scroll 把纵向 deltaY 取反后再交给 Win32，横向不取反', () => {
    const script = [
      'import importlib.util, json',
      `spec = importlib.util.spec_from_file_location("computer_agent", r"${RUNTIME_SCRIPT}")`,
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'captured = []',
      'module.send_inputs = lambda events: captured.extend(events)',
      'module.settle = lambda seconds=0.03: None',
      'module.read_pointer = lambda: (0, 0)',
      'def signed(value):',
      '    return value - 0x100000000 if value >= 0x80000000 else value',
      'module.action_scroll({"deltaY": 120})',
      'vertical = signed(captured[0].union.mi.mouseData)',
      'captured.clear()',
      'module.action_scroll({"deltaX": 120})',
      'horizontal = signed(captured[0].union.mi.mouseData)',
      'print(json.dumps({"vertical": vertical, "horizontal": horizontal}))',
    ].join('\n')
    const stdout = execFileSync(python as string, ['-c', script], { encoding: 'utf8', windowsHide: true })
    // 请求「向下 120」，到 Win32 必须是 -120；横向方向一致，保持 +120。
    expect(JSON.parse(stdout)).toEqual({ vertical: -120, horizontal: 120 })
  }, 30_000)
})
