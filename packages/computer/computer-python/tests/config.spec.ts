/**
 * 配置解析的单元测试：非法配置必须在插件加载时失败，
 * 而不是等到第一次点击鼠标才暴露。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMEOUT_MS, resolveConfig } from '@deepseek-ai/dsh-computer-python'
import { ComputerError } from '@deepseek-ai/dsh-computer'

describe('resolveConfig', () => {
  it('缺省时留空解释器路径并用默认超时', () => {
    expect(resolveConfig({})).toEqual({ pythonPath: '', timeoutMs: DEFAULT_TIMEOUT_MS })
  })

  it('去掉解释器路径两侧空白', () => {
    expect(resolveConfig({ pythonPath: '  C:/Python/python.exe  ' }).pythonPath).toBe('C:/Python/python.exe')
  })

  it('接受自定义超时', () => {
    expect(resolveConfig({ timeoutMs: 5000 }).timeoutMs).toBe(5000)
  })

  it('未知字段在加载期失败', () => {
    expect(() => resolveConfig({ nope: 1 } as never)).toThrow(/未知字段/u)
  })

  it('非法超时在加载期失败', () => {
    expect(() => resolveConfig({ timeoutMs: 0 })).toThrow(/正数/u)
    expect(() => resolveConfig({ timeoutMs: Number.NaN })).toThrow(/正数/u)
  })

  it('非字符串解释器路径在加载期失败', () => {
    expect(() => resolveConfig({ pythonPath: 42 } as never)).toThrow(/字符串/u)
  })
})

describe('ComputerError', () => {
  it('携带稳定错误码与名称', () => {
    const error = new ComputerError('失败了', 'INPUT_FAILED')
    expect(error.code).toBe('INPUT_FAILED')
    expect(error.name).toBe('ComputerError')
    expect(error.message).toBe('失败了')
    expect(error).toBeInstanceOf(Error)
  })
})
