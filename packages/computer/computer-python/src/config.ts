/**
 * `computer-python` 的配置：解释器位置与单次动作超时。
 *
 * @module @deepseek-ai/dsh-computer-python/config
 */

import z from '@deepseek-ai/schemastery'

/** 单次动作的默认超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 20_000

/** 插件配置。 */
export interface Config {
  /**
   * CPython 解释器的绝对路径或 PATH 名。留空则按 `python` → `python3` →
   * `py -3` 的顺序探测第一个能完成一次探测调用的解释器。
   */
  pythonPath?: string
  /** 单次动作的超时（毫秒），默认 20000。截图含 PNG 编码，不宜设得过小。 */
  timeoutMs?: number
}

/** 已解析配置：超时一定存在，`pythonPath` 为空串表示自动探测。 */
export interface ResolvedConfig {
  pythonPath: string
  timeoutMs: number
}

/** 配置 Schema；生成的配置目录从这里读取可接受字段。 */
export const Config: z<Config> = z.object({
  pythonPath: z.string().default(''),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
})

/**
 * 校验并补齐配置。未知字段与非法取值在插件加载时失败，
 * 而不是等到第一次点击鼠标才暴露。
 *
 * @param config - 原始插件配置。
 * @returns 去除未知字段并填好默认值的配置。
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const unknown = Object.keys(config).filter(key => key !== 'pythonPath' && key !== 'timeoutMs')
  if (unknown.length > 0) {
    throw new Error(`computer-python 配置存在未知字段 ${unknown.join(', ')} —— 只接受 { pythonPath, timeoutMs }`)
  }
  const rawPath = config.pythonPath
  if (rawPath !== undefined && typeof rawPath !== 'string') {
    throw new Error('computer-python 的 pythonPath 必须是字符串')
  }
  const pythonPath = (rawPath ?? '').trim()
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`computer-python 的 timeoutMs 必须是正数，收到 ${String(config.timeoutMs)}`)
  }
  return { pythonPath, timeoutMs }
}
