/**
 * 每个 MCP 服务器自己的提示词分段。
 *
 * 服务器名与工具清单都是运行期事实，双语资产那张按名字索引的表挂不上动态分段名，
 * 所以介绍按装配语言现算。这里盯三件事：文本不空（分段靠非空才存在于提示词里，
 * 挂在它后面的经验也才挂得住）、语言跟着装配走、工具清单稳定有序。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { mcpServerIntro, mcpServerSectionName } from '../src/index.ts'
import { registerServerContext } from '../src/server-context.ts'

describe('mcpServerSectionName', () => {
  it('is the server\u2019s own section, so a mounted server is the only way one exists', () => {
    expect(mcpServerSectionName('github')).toBe('mcp:github')
  })
})

describe('mcpServerIntro', () => {
  it('names the server and its tools, sorted', () => {
    const text = mcpServerIntro('github', ['mcp__github__search', 'mcp__github__create_issue'], 'en')
    expect(text).toContain('"github"')
    // 排过序：同一组工具在每次装配里都得给出同一段文本，否则提示词缓存永远失效。
    expect(text.indexOf('create_issue')).toBeLessThan(text.indexOf('search'))
  })

  it('still announces a server whose tools have not synced yet', () => {
    // 空文本的分段会在装配结果里消失，经验也就失去了落脚点；没同步到工具不代表
    // 服务器不存在。
    expect(mcpServerIntro('github', [], 'en')).toContain('"github"')
    expect(mcpServerIntro('github', [], 'zh')).toContain('尚未同步')
  })

  it('follows the assembly language', () => {
    const zh = mcpServerIntro('github', ['mcp__github__search'], 'zh')
    const en = mcpServerIntro('github', ['mcp__github__search'], 'en')
    expect(zh).toContain('本会话装有 MCP 服务器')
    expect(en).toContain('This session has the MCP server')
    // 语言未解析时按英文兜底，与其余分段的默认一致。
    expect(mcpServerIntro('github', [], undefined)).toContain('This session has the MCP server')
  })
})

describe('mcp:<serverName> 分段的接线', () => {
  it('介绍与服务器字面指示落在同一节里，并随注册作用域一起撤销', async () => {
    // 上游 `registerServerContext` 也用这个名字承载服务器的字面指示，所以介绍必须
    // 与它合成一节。此前这条接线是并行注册，撞名后整节从未注册成功——纯函数测试
    // 全绿也看不出介绍根本没进提示词，故在此钉住装配结果。
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const fiber = await ctx.plugin({ apply(inner: Context) {
      registerServerContext(inner, 'github', {
        resources: { request: async () => ({ resources: [] }) },
        instructions: () => 'MCP server: github',
      }, locale => mcpServerIntro('github', ['mcp__github__search'], locale))
    } })

    const rendered = renderPrompt(await ctx.systemPrompt.assemble())
    expect(rendered).toContain('MCP server: github')
    expect(rendered).toContain('mcp__github__search')

    await fiber.dispose()
    const withdrawn = renderPrompt(await ctx.systemPrompt.assemble())
    expect(withdrawn).not.toContain('MCP server: github')
    expect(withdrawn).not.toContain('mcp__github__search')
    await ctx.fiber.dispose()
  })
})

describe('MCP 分段在提示词里的位置', () => {
  it('资源清单紧跟服务器介绍，中间不被别的段落劈开', async () => {
    // 两节合起来才是完整的一句话："有哪些服务器可读资源" + "每台服务器是什么"。
    // fork 把服务器介绍移到了尾部（`MCP_INTRO`，见 SECTION_ORDERS 的注释），资源
    // 清单必须跟着走；留在上游的 `MCP_SERVERS`（3000 与 9000 之间）就会被这一段的
    // 其它段落夹在中间——线上实测正是 `ui:deliverable-file-references` 夹了进去。
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(McpResources)
    const fiber = await ctx.plugin({ apply(inner: Context) {
      // 这一次注册同时提供资源（资源清单因此出现）与字面指示（`mcp:github` 因此出现）。
      registerServerContext(inner, 'github', {
        resources: { request: async () => ({ resources: [] }) },
        instructions: () => 'MCP server: github',
      }, locale => mcpServerIntro('github', ['mcp__github__search'], locale))
    } })

    // 一个恰好落在"上游位置"与尾部之间的段落：没有它，资源清单留在原处也照样相邻，
    // 这条用例就什么也钉不住。
    ctx.systemPrompt.section({
      name: 'ui:deliverable-file-references',
      order: ctx.systemPrompt.getSectionOrder('DELIVERABLE_FILE_REFERENCES'),
      text: 'Cite created files with inline code.',
    })

    const names = (await ctx.systemPrompt.assemble()).sections.map(section => section.name)
    const list = names.indexOf('mcp-resource-servers')
    expect(list).toBeGreaterThan(-1)
    expect(names[list + 1]).toBe('mcp:github')

    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
