import { describe, expect, it } from 'vitest'
import { jsonSchemaToTs, renderToolsSdk } from '@deepseek-ai/dsh-tools/src/ts-types.ts'
import type { ToolSdkSchema } from '@deepseek-ai/dsh-tools/src/ts-types.ts'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools/src/json-schema.ts'
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'

describe('jsonSchemaToTs', () => {
  it('maps every unified schema construct', () => {
    const cases: [unknown, string][] = [
      [{ type: 'string' }, 'string'],
      [{ type: 'number' }, 'number'],
      [{ type: 'integer' }, 'number'],
      [{ type: 'boolean' }, 'boolean'],
      [{ type: 'null' }, 'null'],
      [{ type: 'string', enum: ['a', 'b'] }, '"a" | "b"'],
      [{ type: 'number', enum: [1, 2] }, '1 | 2'],
      [{ type: 'integer', const: 2 }, '2'],
      [{ type: 'boolean', const: true }, 'true'],
      [{ type: 'null', const: null }, 'null'],
      [{ type: 'string', enum: ['a', 'b'], const: 'a' }, '"a"'],
      [{ oneOf: [{ type: 'string' }, { type: 'null' }] }, 'string | null'],
      [{ type: 'array', items: { type: 'number' } }, 'number[]'],
      [{ type: 'array', items: { type: 'string', enum: ['x', 'y'] } }, '("x" | "y")[]'],
      [{ type: 'array' }, 'JsonValue[]'],
      [{ type: 'object' }, 'Record<string, JsonValue>'],
      [{ type: 'object', additionalProperties: false }, 'Record<string, never>'],
      [{ type: 'object', properties: {} }, 'Record<string, JsonValue>'],
      [{ type: 'object', properties: {}, additionalProperties: false }, 'Record<string, never>'],
      [{
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'integer' }, label: { type: 'string' } },
        required: ['id'],
      }, ['{', '  id: number;', '  label?: string;', '}'].join('\n')],
      [{}, 'JsonValue'],
    ]
    for (const [schema, expected] of cases) {
      expect(jsonSchemaToTs(schema), JSON.stringify(schema)).toBe(expected)
    }
  })

  it('renders objects with required/optional keys, nested shapes, and per-property docs', () => {
    const schema = parameterSchemaSpecToJsonSchema({
      path: { type: 'string', required: true, description: 'Absolute file path' },
      limit: { type: 'number' },
      opts: {
        type: 'object',
        additionalProperties: true,
        properties: { deep: { type: 'boolean', required: true } },
      },
    })
    expect(jsonSchemaToTs(schema)).toBe([
      '{',
      '  /** Absolute file path */',
      '  path: string;',
      '  limit?: number;',
      '  opts?: {',
      '    deep: boolean;',
      '  } & Record<string, JsonValue>;',
      '} & Record<string, JsonValue>',
    ].join('\n'))
  })

  it('types a provider-supplied schema that carries a dialect declaration', () => {
    // The MCP SDK's `tools/list` emits `inputSchema` with `$schema` on it, and the
    // bridge relays the object verbatim. This exact schema used to render
    // `unknown`, so a PTC mode program was told which MCP tools exist and what
    // they return but nothing about how to call them.
    const mcpStyle = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
      },
      required: ['a', 'b'],
    }
    expect(jsonSchemaToTs(mcpStyle, 1)).toBe([
      '{',
      '    /** First number */',
      '    a: number;',
      '    /** Second number */',
      '    b: number;',
      '  } & Record<string, JsonValue>',
    ].join('\n'))
  })

  it('types a real-world MCP argument list, whose refining keywords are inert here', () => {
    // `$schema` was only the first keyword to cost an entire tool's arguments.
    // `format`, `pattern`, `minimum` and `uniqueItems` refine a value the
    // declared type already describes, so a subset that cannot enforce them has
    // nothing to gain by rejecting the node that carries them — and under PTC
    // mode it had everything to lose: the whole argument list became `unknown`,
    // and a model with no parameter contract declines to make the call.
    const listIssues = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        since: { type: 'string', format: 'date-time', description: 'Only issues updated at or after this time' },
        page: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
        labels: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true },
        state: { type: 'string', pattern: '^(open|closed)$' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    }
    expect(jsonSchemaToTs(listIssues)).toBe([
      '{',
      '  /** Repository owner */',
      '  owner: string;',
      '  /** Repository name */',
      '  repo: string;',
      '  /** Only issues updated at or after this time */',
      '  since?: string;',
      '  page?: number;',
      '  labels?: string[];',
      '  state?: string;',
      '}',
    ].join('\n'))
  })

  it('resolves a local $ref, and folds the union spellings into one type', () => {
    expect(jsonSchemaToTs({
      $defs: { Filter: { type: 'object', properties: { op: { enum: ['eq', 'ne'] } }, required: ['op'], additionalProperties: false } },
      type: 'object',
      properties: { filter: { $ref: '#/$defs/Filter' } },
      additionalProperties: false,
    })).toBe([
      '{',
      '  filter?: {',
      '    op: "eq" | "ne";',
      '  };',
      '}',
    ].join('\n'))

    expect(jsonSchemaToTs({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null')
    expect(jsonSchemaToTs({ type: ['string', 'number'] })).toBe('string | number')
    expect(jsonSchemaToTs({ enum: ['open', 'closed'] })).toBe('"open" | "closed"')
    // One object shape plus `null` keeps `properties` attached to the half that
    // owns them; only a genuine multi-shape union drops them.
    expect(jsonSchemaToTs({ type: ['object', 'null'], properties: { name: { type: 'string' } }, additionalProperties: false }))
      .toBe('{\n  name?: string;\n} | null')
  })

  it('keeps the keywords a node writes beside its $ref, reachable pointer or not', () => {
    // A dialect that honours `$ref` siblings describes the value with both
    // halves; a pointer that names nothing still leaves the node's own
    // declaration standing. Either way the model sees the argument it must pass.
    expect(jsonSchemaToTs({
      $defs: { Base: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
      type: 'object',
      properties: {
        page: { $ref: '#/$defs/Base', type: 'object', properties: { cursor: { type: 'string' } }, additionalProperties: false },
        legacy: { $ref: '#/$defs/Missing', type: 'string' },
      },
      additionalProperties: false,
    })).toBe([
      '{',
      '  page?: {',
      '    id: string;',
      '    cursor?: string;',
      '  };',
      '  legacy?: string;',
      '}',
    ].join('\n'))

    expect(jsonSchemaToTs({ $ref: '#/$defs/Missing', type: 'string' })).toBe('string')
  })

  it('reads a tuple prefix as the array element type', () => {
    expect(jsonSchemaToTs({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }] }))
      .toBe('(string | number)[]')
    expect(jsonSchemaToTs({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'string' }] }))
      .toBe('string[]')
    expect(jsonSchemaToTs({ type: 'array', prefixItems: [] })).toBe('JsonValue[]')
  })

  it('folds an allOf composition into the object it describes', () => {
    expect(jsonSchemaToTs({
      $defs: { Base: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
      allOf: [{ $ref: '#/$defs/Base' }, { type: 'object', properties: { extra: { type: 'boolean' } } }],
    })).toBe([
      '{',
      '  id: string;',
      '  extra?: boolean;',
      '}',
    ].join('\n'))
  })

  it('terminates on a recursive definition and on a reference it cannot reach', () => {
    expect(jsonSchemaToTs({
      $defs: {
        Node: {
          type: 'object',
          properties: { name: { type: 'string' }, child: { $ref: '#/$defs/Node' } },
          required: ['name'],
          additionalProperties: false,
        },
      },
      $ref: '#/$defs/Node',
    })).toBe([
      '{',
      '  name: string;',
      '  child?: JsonValue;',
      '}',
    ].join('\n'))

    expect(jsonSchemaToTs({ $ref: '#/$defs/Missing' })).toBe('JsonValue')
    expect(jsonSchemaToTs({ $ref: 'https://example.com/schema.json' })).toBe('JsonValue')
  })

  it('is total: a node it cannot read widens instead of throwing', () => {
    const cases: unknown[] = [
      undefined,
      null,
      42,
      'string-schema',
      [],
      {},
      { oneOf: 7 },
      { oneOf: [] },
      { $ref: '#/defs/x' },
      { type: 'object', properties: 7 },
      { type: 'object', properties: { bad: { $ref: 'x' } } },
      { type: 'string', enum: [1, 2] },
      { type: 'string', enum: [] },
    ]
    for (const schema of cases) {
      expect(() => jsonSchemaToTs(schema), JSON.stringify(schema)).not.toThrow()
    }
    // Widening keeps whatever the node did say instead of discarding it: a
    // declared type survives a constraint its own type contradicts, a required
    // name survives a property the node never declared, and a property the node
    // does declare survives a value that is not a schema at all.
    expect(jsonSchemaToTs({ oneOf: [] })).toBe('JsonValue')
    expect(jsonSchemaToTs({ type: 'object', properties: 7 })).toBe('Record<string, JsonValue>')
    expect(jsonSchemaToTs({ type: 'object', properties: { bad: { $ref: 'x' } }, required: ['bad'] }))
      .toBe('{\n  bad: JsonValue;\n} & Record<string, JsonValue>')
    expect(jsonSchemaToTs({ type: 'string', enum: [1, 2] })).toBe('string')
    expect(jsonSchemaToTs({ type: 'string', enum: [] })).toBe('string')
    expect(jsonSchemaToTs({ type: 'object', properties: { a: { type: 'string' } }, required: [7] }))
      .toBe('{\n  a?: string;\n} & Record<string, JsonValue>')
    expect(jsonSchemaToTs({ type: 'object', properties: { weird: 42 } }))
      .toBe('{\n  weird?: JsonValue;\n} & Record<string, JsonValue>')
  })

  it('contains a hostile accessor rather than letting it escape', () => {
    // Not JSON, so the widening boundary makes no promise about it: reading the
    // node throws, and the renderer's own containment answers `unknown`.
    const hostile = Object.defineProperty({}, 'type', { enumerable: true, get() { throw new Error('boom') } })
    expect(jsonSchemaToTs(hostile)).toBe('unknown')
  })

  it('escapes a comment-closer inside a description so the generated JSDoc cannot end early', () => {
    const rendered = jsonSchemaToTs({
      type: 'object',
      properties: { glob: { type: 'string', description: 'a pattern like packages/*/tool-*/ over here' } },
    })
    expect(rendered).not.toContain('tool-*/ over')
    expect(rendered).toContain(String.raw`tool-*\/ over`)
  })

  it('renders deeply nested unions without using the JavaScript call stack', () => {
    const depth = 5_000
    let schema: unknown = { type: 'string' }
    for (let index = 0; index < depth; index++) schema = { oneOf: [schema, { type: 'null' }] }

    const rendered = jsonSchemaToTs(schema)

    expect(rendered.startsWith('string | null')).toBe(true)
    expect(rendered.length).toBe('string'.length + depth * ' | null'.length)
  })
})

describe('renderToolsSdk', () => {
  const bash: ToolSdkSchema = {
    name: 'bash',
    description: 'Run a shell command.',
    parameters: parameterSchemaSpecToJsonSchema({
      command: { type: 'string', required: true },
      description: { type: 'string', required: true },
    }) as unknown as Record<string, unknown>,
    output: {
      type: 'object',
      additionalProperties: false,
      properties: { exitCode: { type: 'integer' } },
      required: ['exitCode'],
    },
  }
  const exotic: ToolSdkSchema = {
    name: 'my-mcp.tool',
    description: 'Exotic name.',
    parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
    output: { type: 'array', items: { type: 'string' } },
  }

  it('declares every tool in lexicographic order with quoted keys for exotic names', () => {
    const text = renderToolsSdk([exotic, bash])
    expect(text).toContain('interface ToolArgsMap {')
    expect(text).toContain('interface ToolOutputMap {')
    expect(text).toContain('type ToolName = keyof ToolOutputMap')
    expect(text).toContain('declare class ToolCallError extends Error')
    expect(text).toContain('readonly toolName: ToolName;')
    expect(text).toContain('declare const tools: {')
    expect(text).toContain('type JsonValue = null | boolean | number | string')
    expect(text.indexOf('bash: {')).toBeGreaterThan(0)
    expect(text).toContain('"my-mcp.tool":')
    expect(text.indexOf('bash:')).toBeLessThan(text.indexOf('"my-mcp.tool":'))
    expect(text).toContain('exitCode: number;')
    expect(text).toContain('"my-mcp.tool": string[];')
    expect(text).toContain('[K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;')
    expect(text).toContain('/** Run a shell command. */')
    // The fixed instruction lines the model relies on.
    expect(text).toContain('erasable syntax only')
    expect(text).toContain('rejects with `ToolCallError`')
    expect(text).toContain('MAY overlap under `Promise.all`')
    expect(text).toContain('lossless JSON')
  })

  it('names both required call arguments, not just the program', () => {
    // The schema requires `code` AND `description`; instructions that mention
    // only the program let a model emit `{code}` alone and fail INVALID_ARGS.
    const text = renderToolsSdk([bash])
    expect(text).toContain('`code`')
    expect(text).toContain('`description`')
    expect(text).toContain('two required arguments')
  })

  it('keeps generated bindings inside a run_code program', () => {
    const text = renderToolsSdk([bash])
    expect(text).toContain('A declaration does not make its name a directly callable tool')
    expect(text).toContain('only names supplied as separate tool schemas may be called directly')
    expect(text).toContain('`run_code({ code: "return await tools.bash({ command: \'pwd\', description: \'Show current directory\' })"')
    expect(text).toContain('Program-only SDK bindings:')
    expect(text).not.toContain('The available tools:')
  })

  it('localizes the prose but never the declarations it introduces', () => {
    // Only the prose follows the assembly language: `declare const tools` is a
    // type projection, and Chinese declaration syntax does not exist. The bash
    // example is code too, so it stays literal while the sentence around it
    // follows the locale.
    const text = renderToolsSdk([bash], 'zh')
    expect(text).toContain('## 为 run_code 写代码')
    expect(text).toContain('仅程序内可用的 SDK 绑定：')
    expect(text).toContain('本次请求没有单独提供 `bash` schema 时，就调用上面声明的 `bash` 绑定：')
    expect(text).toContain('declare const tools: {')
    expect(text).not.toContain('## Writing code for run_code')
  })

  it('only shows a bash example accepted by the declared binding', () => {
    expect(renderToolsSdk([exotic])).not.toContain('tools.bash(')

    const commandOnly = {
      ...bash,
      parameters: parameterSchemaSpecToJsonSchema({
        command: { type: 'string', required: true },
      }) as unknown as Record<string, unknown>,
    }
    expect(renderToolsSdk([commandOnly]))
      .toContain('tools.bash({ command: \'pwd\' })')

    const incompatible = {
      ...bash,
      parameters: parameterSchemaSpecToJsonSchema({
        command: { type: 'string', required: true },
        cwd: { type: 'string', required: true },
      }) as unknown as Record<string, unknown>,
    }
    expect(renderToolsSdk([incompatible])).not.toContain('tools.bash(')

    const parameters = (value: JsonSchemaNode): ToolSdkSchema => ({
      ...bash,
      parameters: value as Record<string, unknown>,
    })
    const rejected: JsonSchemaNode[] = [
      { type: 'string' },
      { type: 'object', properties: {} },
      { type: 'object', properties: { command: { type: 'number' } } },
      { type: 'object', properties: { command: { type: 'string', const: 'date' } } },
      { type: 'object', properties: { command: { type: 'string', enum: ['date'] } } },
      {
        type: 'object',
        properties: { command: { type: 'string' }, description: { type: 'number' } },
        required: ['command', 'description'],
      },
    ]
    for (const schema of rejected) expect(renderToolsSdk([parameters(schema)])).not.toContain('tools.bash(')

    const constrained = parameters({
      type: 'object',
      properties: { command: { type: 'string', const: 'pwd', enum: ['pwd'] } },
    })
    expect(renderToolsSdk([constrained])).toContain('tools.bash({ command: \'pwd\' })')
  })

  it('is deterministic: same tool set, byte-identical text regardless of input order', () => {
    expect(renderToolsSdk([bash, exotic])).toBe(renderToolsSdk([exotic, bash]))
    // Equal names sort stably (the comparator's equal arm).
    expect(renderToolsSdk([bash, bash])).toBe(renderToolsSdk([bash, bash]))
  })

  it('renders an empty declaration for an empty tool set', () => {
    const text = renderToolsSdk([])
    expect(text).toContain('interface ToolArgsMap {}')
    expect(text).toContain('interface ToolOutputMap {}')
  })
})
