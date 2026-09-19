/**
 * Publish connection-owned MCP resources and literal server instructions.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { McpResourceProvider } from '@deepseek-ai/dsh-mcp-resources'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Connection-owned values used by the resource and prompt consumers. */
export interface ServerContext {
  /** Resource access through the current connection generation. */
  resources: McpResourceProvider
  /**
   * Read the last successfully connected server's attributed instructions.
   * @returns literal prompt text, or an empty string when no server instructions are active.
   */
  instructions(): string
  /**
   * 这台服务器当前公开的工具名（`mcp__<server>__<raw>`），也就是它在反思文档里
   * 各自占一行的主题。
   *
   * 可选：只带字面指示的上游调用点没有工具清单，缺省即"这一节没有子主题"——
   * 那正是它的事实，不该由我们编一份出来。
   */
  toolNames?(): readonly string[]
}

/**
 * Contribute server context to the services enabled by this composition.
 *
 * `mcp:<server>` is ONE section by design: the capability's own body, built from
 * three parts in order — the server's literal instructions, this deployment's
 * generated introduction, and the introduction the user wrote for this server
 * (`config.intro`). `error-reflection-prompt` then appends that server's lessons
 * (including its individual tools' lessons) to the same section. The 0.1.3
 * baseline registered the generated introduction here alone; the upstream
 * baseline registers the instructions here alone. All of them must compose into
 * the same name, because a second `section()` for `mcp:<server>` is a
 * duplicate-name error — not a second contribution.
 *
 * 三部分而不是"用户写的覆盖前两部分"：字面指示是服务器的合同、生成介绍是"这台
 * 服务器现在有哪些工具"的事实，两者都不该被一段人手写的介绍抹掉。用户要否定的
 * 是措辞，不是事实；真要改事实就改 `config.intro` 之外的配置。
 *
 * @param ctx - server plugin's registration scope and effect owner.
 * @param server - configured server identity.
 * @param connection - live resource operations and successful instruction snapshot.
 * @param intro - this deployment's generated introduction for one assembly locale;
 * the upstream callers that only carry instructions omit it.
 * @param authored - the user's own introduction for this server; empty when none.
 */
export function registerServerContext(
  ctx: Context,
  server: string,
  connection: ServerContext,
  intro: (locale: string | undefined) => string = () => '',
  authored: string = '',
): void {
  ctx.inject(['mcpResources'], (inner) => {
    inner.mcpResources.register(server, connection.resources)
  })
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: `mcp:${server}`,
      order: inner.systemPrompt.getSectionOrder('MCP_INTRO'),
      interpolate: false,
      text: context => [connection.instructions(), intro(context.locale), authored]
        .filter(text => text.trim() !== '')
        .join('\n\n'),
      // 这一节底下的工具：一个工具在反思文档里各占一个主题，键就是模型看到的公开
      // 工具名。声明出来，编辑界面才能把这一节展开成"每个工具一格"——否则十几个
      // 工具的经验只能挤在服务器这一格里一起改。
      subjects: () => [...connection.toolNames?.() ?? []],
    })
  })
}
