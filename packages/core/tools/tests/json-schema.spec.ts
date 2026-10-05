import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  JsonSchemaError,
  validateJsonSchemaValue,
  type JsonSchemaNode,
  type ObjectJsonSchema,
} from '../src/index.ts'
// The rendering-side reading is internal to the package: the public surface is
// the assertion, and this is the projection `jsonSchemaToTs`/`jsonSchemaToPy`
// call on their way to text.
import { widenJsonSchema } from '../src/json-schema.ts'

function asserted(schema: unknown): JsonSchemaNode {
  assertSupportedJsonSchema(schema)
  return schema
}

function assertedObject(schema: unknown): ObjectJsonSchema {
  assertObjectJsonSchema(schema)
  return schema
}

function violationsOf(schema: unknown, objectRoot = false): string[] {
  try {
    if (objectRoot) assertObjectJsonSchema(schema)
    else assertSupportedJsonSchema(schema)
  } catch (error: unknown) {
    if (error instanceof JsonSchemaError) return error.violations
    throw error
  }
  throw new Error('expected schema rejection')
}

function recordWithForgedIntrinsicPrototype(
  own: Record<string, unknown>,
  inherited: Record<string, unknown> = {},
  revoked = false,
): Record<string, unknown> {
  const prototype = Object.assign(Object.create(null) as Record<string, unknown>, inherited)
  const ForgedObject = function ForgedObject(): void {}
  Object.defineProperty(ForgedObject, 'name', { value: 'Object' })
  ForgedObject.prototype = prototype
  const constructor = revoked ? Proxy.revocable(ForgedObject, {}) : undefined
  if (constructor !== undefined) constructor.revoke()
  Object.defineProperty(prototype, 'constructor', { value: constructor?.proxy ?? ForgedObject })
  return Object.assign(Object.create(prototype) as Record<string, unknown>, own)
}

describe('the enforced raw JSON Schema subset', () => {
  it('accepts every JSON root and every supported node', () => {
    for (const schema of [
      { type: 'string' },
      { type: 'number' },
      { type: 'integer' },
      { type: 'boolean' },
      { type: 'null' },
      { type: 'array', items: { type: 'string' } },
      {
        type: 'object',
        properties: {
          nested: { type: 'object', properties: {}, additionalProperties: false },
          free: {},
        },
        required: ['nested'],
        additionalProperties: true,
      },
      { oneOf: [{ type: 'string' }, { type: 'number' }] },
      { description: 'any JSON', title: 'JSON', default: null, examples: [1, 'x'] },
    ]) {
      expect(() => { assertSupportedJsonSchema(schema) }, JSON.stringify(schema)).not.toThrow()
    }
  })

  it('retains an object-root guard only at consumers that need it', () => {
    expect(assertedObject({ type: 'object' }).type).toBe('object')
    for (const schema of [{}, { type: 'string' }, { type: 'array' }, { oneOf: [{ type: 'string' }, { type: 'null' }] }]) {
      expect(violationsOf(schema, true)).toEqual(['schema.type must be "object" (structured output is object-rooted)'])
    }
  })

  it('rejects non-schema nodes, unknown types, and type arrays', () => {
    expect(violationsOf(null)).toEqual(['schema must be a schema object'])
    expect(violationsOf([])).toEqual(['schema must be a schema object'])
    expect(violationsOf('no')).toEqual(['schema must be a schema object'])
    expect(violationsOf({ type: 'tuple' })[0]).toMatch(/type must be one of/)
    expect(violationsOf({ type: ['string', 'null'] }))
      .toEqual(['schema.type must be a single type string (type arrays are not supported)'])
  })

  it('enforces oneOf vocabulary and its minimum branch count', () => {
    expect(violationsOf({ oneOf: [] })).toEqual(['schema.oneOf must be an array of at least two schemas'])
    expect(violationsOf({ oneOf: [{}] })).toEqual(['schema.oneOf must be an array of at least two schemas'])
    expect(violationsOf({ oneOf: 'x' })).toEqual(['schema.oneOf must be an array of at least two schemas'])
    expect(violationsOf({ type: 'string', oneOf: [{}, {}] }))
      .toEqual(['schema cannot declare both type and oneOf'])
    expect(violationsOf({ oneOf: [{ type: 'string' }, { type: 'number' }], items: {} }))
      .toEqual(['schema.items is not supported beside oneOf'])
    expect(violationsOf({ oneOf: [{ type: 'string' }, { type: 'weird' }] })[0])
      .toContain('schema.oneOf[1].type')
    const sparse = new Array<unknown>(2)
    sparse[0] = { type: 'string' }
    expect(violationsOf({ oneOf: sparse }))
      .toEqual(['schema.oneOf must be an array of at least two schemas'])
    const compensatedSparse = new Array<unknown>(2)
    compensatedSparse[0] = { type: 'string' }
    Object.defineProperty(compensatedSparse, 'extra', { value: true })
    expect(violationsOf({ oneOf: compensatedSparse }))
      .toEqual(['schema.oneOf must be an array of at least two schemas'])
    class ExoticBranches extends Array<unknown> {}
    expect(violationsOf({ oneOf: new ExoticBranches({ type: 'string' }, { type: 'null' }) }))
      .toEqual(['schema.oneOf must be an array of at least two schemas'])
    const explosiveArray = new Proxy([{ type: 'string' }, { type: 'null' }], {
      getPrototypeOf() { throw new Error('prototype trap') },
    })
    expect(violationsOf({ oneOf: explosiveArray }))
      .toEqual(['schema.oneOf must be an array of at least two schemas'])
  })

  it('rejects unknown and misplaced keywords without accepted-then-ignored behavior', () => {
    for (const keyword of ['anyOf', 'allOf', 'not', 'pattern', 'minimum', 'maxLength', '$ref']) {
      expect(violationsOf({ type: 'object', [keyword]: [] })[0]).toContain(`schema.${keyword} is not a supported keyword`)
    }
    expect(violationsOf({ type: 'object', items: {} }))
      .toEqual(['schema.items is not supported on type "object"'])
    expect(violationsOf({ type: 'array', properties: {} }))
      .toEqual(['schema.properties is not supported on type "array"'])
    expect(violationsOf({ type: 'object', enum: ['x'] }))
      .toEqual(['schema.enum is not supported on type "object"'])
    expect(violationsOf({ type: 'array', const: null }))
      .toEqual(['schema.const is not supported on type "array"'])
    expect(violationsOf({ properties: {}, required: [], additionalProperties: true, items: {}, enum: [], const: null }))
      .toEqual([
        'schema.properties requires type or oneOf',
        'schema.required requires type or oneOf',
        'schema.additionalProperties requires type or oneOf',
        'schema.items requires type or oneOf',
        'schema.enum requires type or oneOf',
        'schema.const requires type or oneOf',
      ])
  })

  it('carries the dialect declaration without weakening enforcement', () => {
    // MCP servers stamp `inputSchema` with this URL, and the MCP bridge relays
    // the schema verbatim; rejecting the whole node over one inert annotation is
    // what used to cost the PTC mode SDK every MCP tool's argument types.
    // Typed `unknown` on purpose: a schema that arrives from outside the
    // repository is unvalidated until the assertion narrows it, and the assertion
    // is the only thing that ever promises a `JsonSchemaNode`.
    const declared: unknown = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { a: { type: 'number' } },
      required: ['a'],
    }
    assertSupportedJsonSchema(declared)
    assertObjectJsonSchema(declared)
    // Accepted as an annotation, not as a hole in the subset: the rest still bites.
    expect(validateJsonSchemaValue(declared, { a: 'x' }, '')).toEqual(['"a" must be a number'])
    expect(validateJsonSchemaValue(declared, {}, '')).toEqual(['missing required property "a"'])
    expect(validateJsonSchemaValue(declared, { a: 1 }, '')).toEqual([])
    // The neighbouring strictness is untouched — a real constraint keyword still rejects.
    expect(violationsOf({ ...declared, pattern: '^a$' })[0])
      .toContain('schema.pattern is not a supported keyword')
  })

  it('reports every independent schema violation', () => {
    expect(violationsOf({
      type: 'object',
      pattern: 'x',
      properties: { a: { type: 'weird' }, b: { type: 'string', minimum: 1 } },
    })).toHaveLength(3)
  })

  it('validates object properties, required names, and openness', () => {
    expect(violationsOf({ type: 'object', properties: [] }))
      .toEqual(['schema.properties must be an object of schemas'])
    expect(violationsOf({ type: 'object', properties: { a: 'x' } }))
      .toEqual(['schema.properties.a must be a schema object'])
    expect(violationsOf({ type: 'object', required: 'a' }))
      .toEqual(['schema.required must be an array of strings'])
    expect(violationsOf({ type: 'object', required: [1] }))
      .toEqual(['schema.required must be an array of strings'])
    expect(violationsOf({ type: 'object', properties: {}, required: ['missing'] }))
      .toEqual(['schema.required names "missing" which is not in properties'])
    expect(violationsOf({ type: 'object', additionalProperties: 'yes' }))
      .toEqual(['schema.additionalProperties must be a boolean'])
    expect(violationsOf({ type: 'object', properties: undefined }))
      .toEqual(['schema.properties must be an object of schemas'])
    expect(violationsOf({ type: 'object', properties: undefined, required: ['missing'] }))
      .toEqual([
        'schema.properties must be an object of schemas',
        'schema.required names "missing" which is not in properties',
      ])
    const sparseRequired = new Array<string>(1)
    expect(violationsOf({ type: 'object', required: sparseRequired }))
      .toEqual(['schema.required must be an array of strings'])
  })

  it('requires type-correct scalar enum and const values', () => {
    for (const schema of [
      { type: 'string', enum: ['a'], const: 'a' },
      { type: 'number', enum: [1.5], const: 1.5 },
      { type: 'integer', enum: [1], const: 1 },
      { type: 'boolean', enum: [true], const: true },
      { type: 'null', enum: [null], const: null },
    ]) {
      expect(() => { assertSupportedJsonSchema(schema) }, JSON.stringify(schema)).not.toThrow()
    }

    expect(violationsOf({ type: 'string', enum: [] }))
      .toEqual(['schema.enum must be a non-empty array of string values'])
    expect(violationsOf({ type: 'number', enum: ['1'] }))
      .toEqual(['schema.enum must be a non-empty array of number values'])
    expect(violationsOf({ type: 'integer', enum: [1.5] }))
      .toEqual(['schema.enum must be a non-empty array of integer values'])
    expect(violationsOf({ type: 'number', enum: [Number.NaN] }))
      .toEqual(['schema.enum must be a non-empty array of number values'])
    expect(violationsOf({ type: 'number', const: -0 }))
      .toEqual(['schema.const must be a number value'])
    expect(violationsOf({ type: 'boolean', const: 1 }))
      .toEqual(['schema.const must be a boolean value'])
    expect(violationsOf({ type: 'string', enum: undefined }))
      .toEqual(['schema.enum must be a non-empty array of string values'])
    expect(violationsOf({ type: 'string', enum: ['a'], const: 'b' }))
      .toEqual(['schema.const must be one of schema.enum when both are declared'])
    const sparseEnum = new Array<string>(1)
    expect(violationsOf({ type: 'string', enum: sparseEnum }))
      .toEqual(['schema.enum must be a non-empty array of string values'])
  })

  it('validates annotation types and lossless JSON payloads', () => {
    expect(violationsOf({ description: 1 })).toEqual(['schema.description must be a string'])
    expect(violationsOf({ title: 1 })).toEqual(['schema.title must be a string'])
    for (const [key, value] of [
      ['default', undefined],
      ['examples', [undefined]],
      ['default', Number.POSITIVE_INFINITY],
      ['examples', new Date(0)],
    ] as const) {
      expect(violationsOf({ [key]: value })).toEqual([`schema.${key} annotation must be lossless JSON data`])
    }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(violationsOf({ default: cyclic }))
      .toEqual(['schema.default annotation must be lossless JSON data'])

    const explosive = new Proxy({}, {
      ownKeys() { throw new Error('annotation trap') },
    })
    expect(violationsOf({ examples: explosive }))
      .toEqual(['schema.examples annotation must be lossless JSON data'])
    expect(violationsOf({ default: Object.defineProperty({}, 'hidden', { value: true }) }))
      .toEqual(['schema.default annotation must be lossless JSON data'])
    expect(violationsOf({ default: { [Symbol('hidden')]: true } }))
      .toEqual(['schema.default annotation must be lossless JSON data'])
  })

  it('accepts lossless annotation containers from another JavaScript realm', () => {
    const schema = runInNewContext(`({
      type: 'object',
      properties: { value: { type: 'string', enum: ['x'] } },
      required: ['value'],
      default: { x: 1 },
      examples: [[{ ok: true }]],
    })`) as unknown

    expect(() => { assertSupportedJsonSchema(schema) }).not.toThrow()
  })

  it('rejects cyclic/exotic schema structure but permits sibling reuse', () => {
    const cyclic: Record<string, unknown> = { type: 'object' }
    cyclic.properties = { self: cyclic }
    expect(violationsOf(cyclic)).toEqual(['schema.properties.self is circular'])
    const leaf = { type: 'string' }
    expect(() => { assertSupportedJsonSchema({ type: 'object', properties: { a: leaf, b: leaf } }) }).not.toThrow()
    expect(violationsOf({ type: 'object', properties: new Map() }))
      .toEqual(['schema.properties must be an object of schemas'])
    expect(violationsOf({ type: 'object', properties: { at: new Date(0) } }))
      .toEqual(['schema.properties.at must be a schema object'])

    const forgedSchema = recordWithForgedIntrinsicPrototype(
      { type: 'object' },
      { oneOf: [{ type: 'string' }, { type: 'null' }] },
    )
    expect(violationsOf(forgedSchema)).toEqual(['schema must be a schema object'])
    expect(violationsOf(forgedSchema, true)).toEqual(['schema must be a schema object'])
    expect(violationsOf(recordWithForgedIntrinsicPrototype({ type: 'string' }, {}, true)))
      .toEqual(['schema must be a schema object'])
    const prototypeWithoutConstructor = Object.create(null) as object
    expect(violationsOf(Object.create(prototypeWithoutConstructor) as unknown))
      .toEqual(['schema must be a schema object'])
    expect(violationsOf(Object.defineProperty({ type: 'string' }, 'hidden', { value: true })))
      .toEqual(['schema must be a schema object'])
    expect(violationsOf({ type: 'string', [Symbol('hidden')]: true }))
      .toEqual(['schema must be a schema object'])
    expect(violationsOf(new Proxy({}, {
      getPrototypeOf() { throw new Error('prototype trap') },
    }))).toEqual(['schema must be a schema object'])
    expect(violationsOf(new Proxy({}, {
      ownKeys() { throw new Error('keys trap') },
    }))).toEqual(['schema must be a schema object'])
  })

  it('asserts deeply nested raw unions without using the JavaScript call stack', () => {
    const depth = 5_000
    let schema: JsonSchemaNode = { type: 'string' }
    for (let index = 0; index < depth; index++) schema = { oneOf: [schema, { type: 'null' }] }

    expect(() => { assertSupportedJsonSchema(schema) }).not.toThrow()
  })

  it('uses own-property semantics for required declarations', () => {
    expect(violationsOf({ type: 'object', properties: {}, required: ['toString'] }))
      .toEqual(['schema.required names "toString" which is not in properties'])
  })
})

describe('validateJsonSchemaValue', () => {
  it('validates scalar, array, object, and null roots', () => {
    expect(validateJsonSchemaValue(asserted({ type: 'string' }), 'x')).toEqual([])
    expect(validateJsonSchemaValue(asserted({ type: 'number' }), 1.5)).toEqual([])
    expect(validateJsonSchemaValue(asserted({ type: 'integer' }), 2)).toEqual([])
    expect(validateJsonSchemaValue(asserted({ type: 'boolean' }), true)).toEqual([])
    expect(validateJsonSchemaValue(asserted({ type: 'null' }), null)).toEqual([])
    expect(validateJsonSchemaValue(asserted({ type: 'array', items: { type: 'string' } }), ['x'])).toEqual([])
    expect(validateJsonSchemaValue(asserted({ type: 'object' }), { x: 1 })).toEqual([])
  })

  it('rejects wrong scalar types and lossy numbers', () => {
    expect(validateJsonSchemaValue(asserted({ type: 'string' }), 1)).toEqual(['"value" must be a string'])
    expect(validateJsonSchemaValue(asserted({ type: 'number' }), '1')).toEqual(['"value" must be a number'])
    expect(validateJsonSchemaValue(asserted({ type: 'number' }), Number.NaN)).toEqual(['"value" must be a finite JSON number'])
    expect(validateJsonSchemaValue(asserted({ type: 'number' }), -0)).toEqual(['"value" must be a finite JSON number'])
    expect(validateJsonSchemaValue(asserted({ type: 'integer' }), 1.5)).toEqual(['"value" must be an integer'])
    expect(validateJsonSchemaValue(asserted({ type: 'boolean' }), 'true')).toEqual(['"value" must be a boolean'])
    expect(validateJsonSchemaValue(asserted({ type: 'null' }), 0)).toEqual(['"value" must be null'])
  })

  it('enforces scalar enum and const together', () => {
    const schema = asserted({ type: 'string', enum: ['a', 'b'], const: 'a' })
    expect(validateJsonSchemaValue(schema, 'a')).toEqual([])
    expect(validateJsonSchemaValue(schema, 'c')).toEqual(['"value" must be one of ["a","b"]'])
    expect(validateJsonSchemaValue(schema, 'b')).toEqual(['"value" must be "a"'])
  })

  it('validates object requiredness, nested values, and raw open defaults', () => {
    const open = asserted({
      type: 'object',
      properties: {
        file: { type: 'string' },
        nested: {
          type: 'object',
          properties: { line: { type: 'integer' } },
          required: ['line'],
          additionalProperties: false,
        },
      },
      required: ['file'],
    })
    expect(validateJsonSchemaValue(open, { file: 'a', extra: [1], nested: { line: 2 } })).toEqual([])
    expect(validateJsonSchemaValue(open, { nested: { line: 1 } }))
      .toEqual(['missing required property "value.file"'])
    expect(validateJsonSchemaValue(open, { file: 1, nested: {} })).toEqual([
      '"value.file" must be a string',
      'missing required property "value.nested.line"',
    ])
    expect(validateJsonSchemaValue(open, { file: 'a', nested: { line: 1, extra: true } }))
      .toEqual(['"value.nested.extra" is not a declared property (additionalProperties: false)'])
    expect(validateJsonSchemaValue(open, 'x')).toEqual(['"value" must be an object'])
  })

  it('treats present undefined as missing when required, then rejects other lossy objects', () => {
    const required = asserted({ type: 'object', properties: { x: {} }, required: ['x'] })
    expect(validateJsonSchemaValue(required, { x: undefined }))
      .toEqual(['missing required property "value.x"'])
    expect(validateJsonSchemaValue(asserted({ type: 'object' }), { x: undefined }))
      .toEqual(['"value" must be a lossless JSON object'])
    expect(validateJsonSchemaValue(asserted({ type: 'object' }), new Date(0)))
      .toEqual(['"value" must be an object'])
  })

  it('returns a violation instead of throwing for a container with a hostile getter', () => {
    const value = Object.defineProperty({}, 'answer', {
      enumerable: true,
      get() { throw new Error('getter exploded') },
    })
    const schema = asserted({
      type: 'object',
      properties: { answer: { type: 'integer' } },
      required: ['answer'],
    })

    expect(validateJsonSchemaValue(schema, value))
      .toEqual(['"value" must be a lossless JSON value'])
  })

  it('validates dense arrays per index and rejects lossy arrays', () => {
    const schema = asserted({ type: 'array', items: { type: 'integer' } })
    expect(validateJsonSchemaValue(schema, [1, 2])).toEqual([])
    expect(validateJsonSchemaValue(schema, runInNewContext('[1, 2]'))).toEqual([])
    expect(validateJsonSchemaValue(schema, [1, 1.5])).toEqual(['"value[1]" must be an integer'])
    expect(validateJsonSchemaValue(schema, 'x')).toEqual(['"value" must be an array'])
    const sparse: number[] = []
    sparse.length = 2
    sparse[0] = 1
    expect(validateJsonSchemaValue(schema, sparse)).toEqual(['"value" must be a dense lossless JSON array'])
  })

  it('validates exact-one oneOf semantics, including overlap', () => {
    const disjoint = asserted({ oneOf: [{ type: 'string' }, { type: 'number' }] })
    expect(validateJsonSchemaValue(disjoint, 'x')).toEqual([])
    expect(validateJsonSchemaValue(disjoint, null))
      .toEqual(['"value" must match exactly one oneOf branch (matched 0)'])
    const overlap = asserted({ oneOf: [{ type: 'number' }, { type: 'integer' }] })
    expect(validateJsonSchemaValue(overlap, 1))
      .toEqual(['"value" must match exactly one oneOf branch (matched 2)'])
    expect(validateJsonSchemaValue(overlap, 1.5)).toEqual([])
  })

  it('validates deeply nested exact-one unions without using the JavaScript call stack', () => {
    const depth = 5_000
    let schema: JsonSchemaNode = { type: 'string' }
    for (let index = 0; index < depth; index++) schema = { oneOf: [schema, { type: 'null' }] }
    assertSupportedJsonSchema(schema)

    expect(validateJsonSchemaValue(schema, 'leaf')).toEqual([])
    expect(validateJsonSchemaValue(schema, 42))
      .toEqual(['"value" must match exactly one oneOf branch (matched 0)'])
  })

  it('an unconstrained schema accepts only lossless JSON values', () => {
    const anyJson = asserted({})
    for (const value of [null, true, 1, 'x', [1], { x: null }]) {
      expect(validateJsonSchemaValue(anyJson, value), JSON.stringify(value)).toEqual([])
    }
    for (const value of [undefined, () => 1, Number.POSITIVE_INFINITY, -0, new Map()]) {
      expect(validateJsonSchemaValue(anyJson, value)).toEqual(['"value" must be a lossless JSON value'])
    }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(validateJsonSchemaValue(anyJson, cyclic)).toEqual(['"value" must be a lossless JSON value'])
    const explosive = new Proxy({}, {
      ownKeys() { throw new Error('value trap') },
    })
    expect(validateJsonSchemaValue(anyJson, explosive)).toEqual(['"value" must be a lossless JSON value'])
  })

  it('uses own properties for requiredness, recursion, and closed-object checks', () => {
    expect(validateJsonSchemaValue(
      asserted({ type: 'object', properties: { toString: { type: 'string' } }, required: ['toString'] }),
      {},
    )).toEqual(['missing required property "value.toString"'])
    expect(validateJsonSchemaValue(asserted({ type: 'object', additionalProperties: false }), { toString: 1 }))
      .toEqual(['"value.toString" is not a declared property (additionalProperties: false)'])
    expect(validateJsonSchemaValue(
      asserted({ type: 'object', properties: { constructor: { type: 'string' } } }),
      {},
    )).toEqual([])

    const inheritedUnion = Object.assign(
      Object.create({ oneOf: [{ type: 'string' }, { type: 'null' }] }) as JsonSchemaNode,
      { type: 'object' as const },
    )
    expect(validateJsonSchemaValue(inheritedUnion, {})).toEqual([])
    expect(validateJsonSchemaValue(inheritedUnion, 'x')).toEqual(['"value" must be an object'])
    expect(validateJsonSchemaValue(
      { type: 'object', properties: undefined } as unknown as JsonSchemaNode,
      {},
    )).toEqual([])
    expect(validateJsonSchemaValue(
      { type: 'object', required: undefined } as unknown as JsonSchemaNode,
      {},
    )).toEqual([])
  })

  it('keeps assertNever as a forged-schema backstop', () => {
    const forged = { type: 'tuple' } as unknown as JsonSchemaNode
    expect(() => validateJsonSchemaValue(forged, 1)).toThrow(/tuple/)
  })
})

describe('widenJsonSchema', () => {
  // Enforcement and rendering want opposite things from a foreign schema, so
  // the reading is pinned separately from the assertion: what matters here is
  // which subset construct each dialect spelling lands on, not whether it was
  // accepted. A node the subset cannot express must still reach the renderer
  // as SOME type, because under PTC mode that text is the model's only
  // description of how to call a tool.
  it('keeps the constructs the subset enforces and drops every refining keyword', () => {
    expect(widenJsonSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'https://example.com/s',
      title: 'T',
      description: 'D',
      type: 'object',
      properties: { a: { type: 'string', format: 'date-time', pattern: '^x$', minLength: 1 } },
      required: ['a'],
      additionalProperties: false,
      $defs: { Unused: { type: 'string' } },
      deprecated: true,
      'x-vendor': 1,
    })).toEqual({
      title: 'T',
      description: 'D',
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    })
  })

  it('reads a value that is not a schema as the annotation-only node', () => {
    for (const value of [undefined, null, 42, 'schema', [], true]) {
      expect(widenJsonSchema(value), JSON.stringify(value)).toEqual({})
    }
  })

  it('resolves a local JSON pointer against the root, unwrapping its escapes', () => {
    expect(widenJsonSchema({
      $defs: { 'a/b': { type: 'string' }, 'a~b': { type: 'boolean' }, Deep: { properties: { x: { type: 'integer' } } } },
      type: 'object',
      properties: {
        direct: { $ref: '#/$defs/Deep/properties/x' },
        escaped: { $ref: '#/$defs/a~1b' },
        tilde: { $ref: '#/$defs/a~0b' },
      },
      additionalProperties: false,
    })).toEqual({
      type: 'object',
      properties: { direct: { type: 'integer' }, escaped: { type: 'string' }, tilde: { type: 'boolean' } },
      additionalProperties: false,
    })
  })

  it('widens a reference it cannot reach, and terminates on a recursive one', () => {
    expect(widenJsonSchema({ $ref: '#/$defs/Missing' })).toEqual({})
    expect(widenJsonSchema({ $ref: 'https://example.com/s.json' })).toEqual({})
    expect(widenJsonSchema({ $ref: '#' })).toEqual({})
    expect(widenJsonSchema({ $defs: { S: 'not-a-schema' }, $ref: '#/$defs/S' })).toEqual({})
    expect(widenJsonSchema({ $ref: '#/a/b', a: 1 })).toEqual({})
    expect(widenJsonSchema({
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } }, additionalProperties: false } },
      $ref: '#/$defs/Node',
    })).toEqual({ type: 'object', properties: { child: {} }, additionalProperties: false })
  })

  it('folds the keywords a node writes beside its $ref, and keeps them when the pointer resolves to nothing', () => {
    expect(widenJsonSchema({
      $defs: { Base: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      type: 'object',
      properties: {
        merged: {
          $ref: '#/$defs/Base',
          description: 'd',
          type: 'object',
          properties: { extra: { type: 'boolean' } },
          required: ['extra'],
        },
        plain: { $ref: '#/$defs/Base', description: 'd' },
      },
    })).toEqual({
      type: 'object',
      properties: {
        merged: {
          description: 'd',
          type: 'object',
          properties: { id: { type: 'string' }, extra: { type: 'boolean' } },
          required: ['id', 'extra'],
        },
        plain: { description: 'd', type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    })
    expect(widenJsonSchema({ $ref: '#/$defs/Missing', type: 'string', description: 'd' }))
      .toEqual({ description: 'd', type: 'string' })
    expect(widenJsonSchema({ $ref: '#/$defs/Missing', properties: { a: { type: 'integer' } } }))
      .toEqual({ type: 'object', properties: { a: { type: 'integer' } } })
    expect(widenJsonSchema({
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node', description: 'd' } } } },
      $ref: '#/$defs/Node',
    })).toEqual({ type: 'object', properties: { child: { description: 'd' } } })
  })

  it('reads a tuple prefix as the array element type, collapsing a repeated shape', () => {
    expect(widenJsonSchema({ type: 'array', prefixItems: [{ type: 'string' }] }))
      .toEqual({ type: 'array', items: { type: 'string' } })
    expect(widenJsonSchema({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'string' }] }))
      .toEqual({ type: 'array', items: { type: 'string' } })
    expect(widenJsonSchema({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] }))
      .toEqual({ type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } })
    // `items` describes every position, so it wins over a prefix that refines only the first few.
    expect(widenJsonSchema({ type: 'array', items: { type: 'boolean' }, prefixItems: [{ type: 'string' }] }))
      .toEqual({ type: 'array', items: { type: 'boolean' } })
    expect(widenJsonSchema({ type: 'array', prefixItems: [] })).toEqual({ type: 'array' })
    expect(widenJsonSchema({ type: 'array', prefixItems: 'x' })).toEqual({ type: 'array' })
  })

  it('pools oneOf and anyOf into one union, inlining a single branch', () => {
    expect(widenJsonSchema({ oneOf: [{ type: 'string' }], description: 'd' })).toEqual({ description: 'd', type: 'string' })
    expect(widenJsonSchema({ oneOf: [{ type: 'string' }, { type: 'number' }] }))
      .toEqual({ oneOf: [{ type: 'string' }, { type: 'number' }] })
    expect(widenJsonSchema({ anyOf: [{ type: 'string' }, { type: 'null' }], description: 'd' }))
      .toEqual({ description: 'd', oneOf: [{ type: 'string' }, { type: 'null' }] })
    expect(widenJsonSchema({ oneOf: [{ type: 'string' }], anyOf: [{ type: 'number' }] }))
      .toEqual({ oneOf: [{ type: 'string' }, { type: 'number' }] })
    expect(widenJsonSchema({ oneOf: [] })).toEqual({})
    expect(widenJsonSchema({ oneOf: 7 })).toEqual({})
  })

  it('folds an allOf composition into one object, and widens one it cannot absorb', () => {
    expect(widenJsonSchema({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
        { type: 'object', properties: { a: { type: 'number' }, b: { type: 'boolean' } }, required: ['a', 'b'] },
      ],
    })).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'boolean' } },
      required: ['a', 'b'],
      additionalProperties: false,
    })
    expect(widenJsonSchema({ allOf: [{ type: 'object', properties: { a: { type: 'string' } } }] }))
      .toEqual({ type: 'object', properties: { a: { type: 'string' } } })
    expect(widenJsonSchema({ allOf: [{ type: 'object' }, { type: 'object', properties: { a: { type: 'string' } } }] }))
      .toEqual({ type: 'object', properties: { a: { type: 'string' } } })
    // An intersection with something that is not an object, a union, or nothing
    // typed at all has no single type to name, so the fold widens wholesale.
    expect(widenJsonSchema({ allOf: [{ type: 'string' }] })).toEqual({})
    expect(widenJsonSchema({ allOf: [{ oneOf: [{ type: 'string' }, { type: 'null' }] }] })).toEqual({})
    expect(widenJsonSchema({ allOf: [{}, {}] })).toEqual({})
    expect(widenJsonSchema({ allOf: [] })).toEqual({})
    expect(widenJsonSchema({ allOf: [{ type: 'object' }], properties: { a: { type: 'string' } } })).toEqual({})
  })

  it('reads every type spelling a foreign dialect uses', () => {
    expect(widenJsonSchema({ type: ['string', 'number'] }))
      .toEqual({ oneOf: [{ type: 'string' }, { type: 'number' }] })
    expect(widenJsonSchema({ type: ['string', 'number'], nullable: true }))
      .toEqual({ oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] })
    expect(widenJsonSchema({ type: ['string', 'null', 'number'] }))
      .toEqual({ oneOf: [{ type: 'string' }, { type: 'null' }, { type: 'number' }] })
    expect(widenJsonSchema({ type: ['string', 'string'] })).toEqual({ type: 'string' })
    expect(widenJsonSchema({ type: ['string', 'nope'] })).toEqual({ type: 'string' })
    expect(widenJsonSchema({ type: 'string', nullable: true }))
      .toEqual({ oneOf: [{ type: 'string' }, { type: 'null' }] })
    expect(widenJsonSchema({ type: 'null' })).toEqual({ type: 'null' })
    expect(widenJsonSchema({ type: ['null'] })).toEqual({ type: 'null' })
    expect(widenJsonSchema({ type: 'json', description: 'd' })).toEqual({ description: 'd' })
    expect(widenJsonSchema({ type: 42 })).toEqual({})
    expect(widenJsonSchema({ nullable: true })).toEqual({})
  })

  it('keeps a literal constraint only where the declared type admits it', () => {
    expect(widenJsonSchema({ type: 'string', enum: ['a', 'b'], const: 'a' }))
      .toEqual({ type: 'string', enum: ['a', 'b'], const: 'a' })
    expect(widenJsonSchema({ type: 'string', enum: [1, 2] })).toEqual({ type: 'string' })
    expect(widenJsonSchema({ type: 'string', enum: [] })).toEqual({ type: 'string' })
    expect(widenJsonSchema({ type: 'string', const: 7 })).toEqual({ type: 'string' })
    expect(widenJsonSchema({ type: 'integer', enum: [1, 2] })).toEqual({ type: 'integer', enum: [1, 2] })
    expect(widenJsonSchema({ type: 'integer', enum: [1.5] })).toEqual({ type: 'integer' })
  })

  it('infers a scalar type from a bare const or enum, and widens a set that mixes types', () => {
    expect(widenJsonSchema({ const: 'fixed', description: 'd' })).toEqual({ description: 'd', type: 'string', const: 'fixed' })
    expect(widenJsonSchema({ const: null })).toEqual({ type: 'null', const: null })
    expect(widenJsonSchema({ const: true })).toEqual({ type: 'boolean', const: true })
    expect(widenJsonSchema({ const: 2.5 })).toEqual({ type: 'number', const: 2.5 })
    expect(widenJsonSchema({ const: { a: 1 } })).toEqual({})
    expect(widenJsonSchema({ enum: ['open', 'closed'] })).toEqual({ type: 'string', enum: ['open', 'closed'] })
    expect(widenJsonSchema({ enum: ['a', 1] })).toEqual({})
    expect(widenJsonSchema({ enum: [{ a: 1 }] })).toEqual({})
    expect(widenJsonSchema({ enum: [] })).toEqual({})
    expect(widenJsonSchema({ enum: 7 })).toEqual({})
  })

  it('reads the shape a node declares outside its type keyword', () => {
    expect(widenJsonSchema({ properties: { a: { type: 'string' } } }))
      .toEqual({ type: 'object', properties: { a: { type: 'string' } } })
    expect(widenJsonSchema({ description: 'd' })).toEqual({ description: 'd' })
    expect(widenJsonSchema({ type: 'object', properties: 7 })).toEqual({ type: 'object' })
    expect(widenJsonSchema({ type: 'object', additionalProperties: false }))
      .toEqual({ type: 'object', additionalProperties: false })
    expect(widenJsonSchema({ type: 'object', additionalProperties: true })).toEqual({ type: 'object' })
    // A tuple `items` has no single item schema, so the array keeps its element
    // count and loses only what it cannot say.
    expect(widenJsonSchema({ type: 'array', items: [{ type: 'string' }] })).toEqual({ type: 'array' })
    expect(widenJsonSchema({ type: 'array', items: { type: 'string' } }))
      .toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('keeps an annotation on a node whose type schedules children', () => {
    expect(widenJsonSchema({ type: 'object', description: 'd', properties: { a: { type: 'string' } } }))
      .toEqual({ description: 'd', type: 'object', properties: { a: { type: 'string' } } })
    expect(widenJsonSchema({ type: ['array', 'null'], items: { type: 'string' } }))
      .toEqual({ oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] })
  })

  it('keeps only the required names the property map actually declares', () => {
    expect(widenJsonSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'ghost', 7] }))
      .toEqual({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })
    expect(widenJsonSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'a'] }))
      .toEqual({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })
    expect(widenJsonSchema({ type: 'object', properties: { a: { type: 'string' } }, required: 'a' }))
      .toEqual({ type: 'object', properties: { a: { type: 'string' } } })
  })
})
