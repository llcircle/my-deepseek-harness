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
}

/**
 * Contribute server context to the services enabled by this composition.
 *
 * `mcp:<server>` is ONE section by design: the capability's own body (the
 * server's literal instructions followed by this deployment's introduction),
 * which `error-reflection-prompt` then appends that server's lessons to. The
 * 0.1.3 baseline registered the introduction here alone; the upstream baseline
 * registers the instructions here alone. Both must compose into the same name,
 * because a second `section()` for `mcp:<server>` is a duplicate-name error —
 * not a second contribution.
 *
 * @param ctx - server plugin's registration scope and effect owner.
 * @param server - configured server identity.
 * @param connection - live resource operations and successful instruction snapshot.
 * @param intro - this deployment's introduction for one assembly locale; the
 * upstream callers that only carry instructions omit it.
 */
export function registerServerContext(
  ctx: Context,
  server: string,
  connection: ServerContext,
  intro: (locale: string | undefined) => string = () => '',
): void {
  ctx.inject(['mcpResources'], (inner) => {
    inner.mcpResources.register(server, connection.resources)
  })
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: `mcp:${server}`,
      order: inner.systemPrompt.getSectionOrder('MCP_INTRO'),
      interpolate: false,
      text: context => [connection.instructions(), intro(context.locale)]
        .filter(text => text.trim() !== '')
        .join('\n\n'),
    })
  })
}
