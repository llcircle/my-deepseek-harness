/**
 * Enforced JSON Schema subset shared by tool outputs, generated PTC mode
 * types, subagents, and workflows. The subset accepts any JSON root, an
 * annotation-only schema for unconstrained JSON, one scalar `type`, object
 * `properties`/`required`/boolean `additionalProperties`, array `items`,
 * type-correct scalar `enum`/`const`, and exact-one `oneOf`.
 *
 * Unsupported or misplaced keywords reject rather than being accepted without
 * enforcement. Consumers that require an object root apply
 * {@link assertObjectJsonSchema} before accepting input.
 *
 * Enforcement and rendering want opposite things from a schema, so the module
 * carries both. {@link widenJsonSchema} answers the rendering question — which
 * type should the model be told to pass — for schemas that arrive from outside
 * the repository and were never written against this subset.
 * @module dsh-tools/json-schema
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import { assertNever, isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

/** Scalar JSON values supported by `enum` and `const`. */
export type JsonSchemaScalar = string | number | boolean | null

/** Single-type keywords accepted by the enforced subset. */
export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

/** Scalar-only schema types accepted by literal constraints. */
type JsonSchemaScalarType = Exclude<JsonSchemaType, 'object' | 'array'>

/**
 * One raw JSON Schema node in the enforced subset. The optional fields express
 * the external wire schema; {@link assertSupportedJsonSchema} rejects invalid
 * combinations before a caller treats the node as trusted.
 */
export interface JsonSchemaNode {
  /** Omit with no constraints for any JSON value, or use `oneOf`. */
  type?: JsonSchemaType
  /** Exactly one branch must validate; at least two branches are required. */
  oneOf?: JsonSchemaNode[]
  /** Nested property schemas (`type: 'object'` only). */
  properties?: Record<string, JsonSchemaNode>
  /** Required property names; each must appear in `properties`. */
  required?: string[]
  /** `false` rejects undeclared keys; absent/`true` follows JSON Schema's open default. */
  additionalProperties?: boolean
  /** Item schema (`type: 'array'` only); absent accepts any JSON item. */
  items?: JsonSchemaNode
  /** Allowed values for a scalar node. */
  enum?: JsonSchemaScalar[]
  /** The single allowed value for a scalar node. */
  const?: JsonSchemaScalar
  /** Annotation, ignored for validation. */
  description?: string
  /** Annotation, ignored for validation. */
  title?: string
  /** Annotation, ignored for validation but required to be lossless JSON. */
  default?: JsonValue
  /** Annotation, ignored for validation but required to be lossless JSON. */
  examples?: JsonValue
}

/** A consumer-constrained object-rooted schema. */
export type ObjectJsonSchema = JsonSchemaNode & { type: 'object' }

/**
 * Thrown when a raw schema falls outside the enforced subset. `violations`
 * lists every offending path instead of stopping at the first author error.
 */
export class JsonSchemaError extends HarnessError {
  /** Individual schema violations in walk order. */
  readonly violations: string[]

  constructor(violations: string[]) {
    super(`unsupported JSON schema: ${violations.join('; ')}`, 'UNSUPPORTED_SCHEMA')
    this.name = 'JsonSchemaError'
    this.violations = violations
  }
}

const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])
/**
 * Keywords carried through untouched.
 *
 * `$schema` rides here, not with the constraints: it declares a JSON-Schema
 * dialect, and a subset that resolves no reference of any dialect can only find
 * the declaration inert. It is tolerated by {@link validateJsonSchemaValue}
 * already, and the schemas that arrive from outside the repository routinely
 * carry it — the MCP SDK stamps every tool's `inputSchema` with one — so the
 * only thing a strict keyword check buys is losing the whole schema. That is
 * not a hypothetical: `jsonSchemaToTs` degrades a rejected schema to `unknown`,
 * so rejecting `$schema` cost the PTC mode SDK every MCP tool's argument types
 * while the value validator happily enforced the same schema.
 */
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples', '$schema'])
const SCHEMA_TYPES: readonly JsonSchemaType[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/* jscpd:ignore-start -- this realm boundary mirrors the session-owned lossless-JSON intrinsic test */
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor(prototype: object, name: 'Array' | 'Object'): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
  const constructor: unknown = descriptor?.value
  if (typeof constructor !== 'function') return false
  try {
    return constructor.name === name
      && constructor.prototype === prototype
      && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`
  } catch {
    return false
  }
}

/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype(value: object): boolean {
  return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, 'Object')
}

/**
 * Test for a realm-agnostic plain JSON record without accepting arrays or
 * exotic objects.
 * @param value - candidate record from any JavaScript realm.
 * @returns Whether the value has a plain-object prototype chain.
 */
export function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype: unknown = Object.getPrototypeOf(value)
    return prototype === null
      || typeof prototype === 'object' && isIntrinsicObjectPrototype(prototype)
  } catch {
    return false
  }
}

/** Whether an array uses one realm's intrinsic `Array.prototype`. */
function hasPlainArrayPrototype(value: unknown[]): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, 'Array')) return false
  const objectPrototype: unknown = Object.getPrototypeOf(prototype)
  return typeof objectPrototype === 'object'
    && objectPrototype !== null
    && isIntrinsicObjectPrototype(objectPrototype)
}
/* jscpd:ignore-end */

/** Return whether a record contains only own enumerable string keys. */
function hasOnlyEnumerableStringKeys(value: object): boolean {
  try {
    return Reflect.ownKeys(value)
      .every(key => typeof key === 'string' && Object.prototype.propertyIsEnumerable.call(value, key))
  } catch {
    return false
  }
}

/**
 * Test for an ordinary schema record whose keys survive JSON projection.
 * @param value - candidate record from any JavaScript realm.
 * @returns Whether the record has an intrinsic prototype and only own enumerable string keys.
 */
export function isJsonSchemaRecord(value: unknown): value is Record<string, unknown> {
  return isPlainJsonRecord(value) && hasOnlyEnumerableStringKeys(value)
}

/**
 * Test for a dense ordinary array with no JSON-invisible decorations.
 * @param value - candidate array from any JavaScript realm.
 * @returns Whether the array is intrinsic, dense, and undecorated.
 */
export function isPlainJsonArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  try {
    if (!hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) return false
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) return false
    }
    return true
  } catch {
    return false
  }
}

/** Lossless finite JSON number, excluding negative zero. */
function isJsonNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
}

/** Whether a scalar is valid for one declared schema type. */
function scalarMatches(type: JsonSchemaScalarType, value: unknown): value is JsonSchemaScalar {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return isJsonNumber(value)
    case 'integer': return isJsonNumber(value) && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    /* v8 ignore next -- JsonSchemaScalarType is closed; this retains compile-time exhaustiveness. */
    default: return assertNever(type, 'JsonSchemaType')
  }
}

/** Deferred work for the stack-safe raw-schema walk. */
type SchemaWalkTask =
  | { kind: 'enter'; node: unknown; path: string }
  | { kind: 'leave'; node: object }
  | { kind: 'one-of-tail'; node: Record<string, unknown>; path: string }
  | { kind: 'object-tail'; node: Record<string, unknown>; path: string; properties: unknown }

/** Keywords that are invalid beside `oneOf`. */
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'] as const

/** Validate object-only fields after its property schemas have been visited. */
function checkObjectSchemaTail(
  node: Record<string, unknown>,
  path: string,
  properties: unknown,
  violations: string[],
): void {
  const hasRequired = Object.hasOwn(node, 'required')
  const required = hasRequired ? node.required : undefined
  if (hasRequired) {
    if (!isPlainJsonArray(required) || required.some(entry => typeof entry !== 'string')) {
      violations.push(`${path}.required must be an array of strings`)
    } else {
      const declared = isJsonSchemaRecord(properties) ? properties : {}
      for (const key of required as string[]) {
        if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`)
      }
    }
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties must be a boolean`)
  }
}

/** Collect every violation for one raw schema tree without using the JavaScript call stack. */
function checkSchemaNode(root: unknown, rootPath: string, violations: string[], seen: Set<object>): void {
  const tasks: SchemaWalkTask[] = [{ kind: 'enter', node: root, path: rootPath }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      seen.delete(task.node)
      continue
    }
    if (task.kind === 'one-of-tail') {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(task.node, key)) violations.push(`${task.path}.${key} is not supported beside oneOf`)
      }
      continue
    }
    if (task.kind === 'object-tail') {
      checkObjectSchemaTail(task.node, task.path, task.properties, violations)
      continue
    }

    const { node, path } = task
    if (!isJsonSchemaRecord(node)) {
      violations.push(`${path} must be a schema object`)
      continue
    }
    if (seen.has(node)) {
      violations.push(`${path} is circular`)
      continue
    }
    seen.add(node)
    tasks.push({ kind: 'leave', node })

    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key)) continue
      if (ANNOTATION_KEYWORDS.has(key)) {
        try {
          if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`)
        } catch {
          violations.push(`${path}.${key} annotation must be lossless JSON data`)
        }
        continue
      }
      violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`)
    }
    if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
      violations.push(`${path}.description must be a string`)
    }
    if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') {
      violations.push(`${path}.title must be a string`)
    }

    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')
    if (hasType && hasOneOf) {
      violations.push(`${path} cannot declare both type and oneOf`)
      continue
    }
    if (!hasType && !hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`)
      }
      continue
    }

    if (hasOneOf) {
      const oneOf = node.oneOf
      tasks.push({ kind: 'one-of-tail', node, path })
      if (!isPlainJsonArray(oneOf) || oneOf.length < 2) {
        violations.push(`${path}.oneOf must be an array of at least two schemas`)
      } else {
        for (let index = oneOf.length - 1; index >= 0; index--) {
          tasks.push({ kind: 'enter', node: oneOf[index], path: `${path}.oneOf[${index}]` })
        }
      }
      continue
    }

    const type = node.type
    if (typeof type !== 'string' || !(SCHEMA_TYPES as readonly unknown[]).includes(type)) {
      violations.push(Array.isArray(type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
      continue
    }
    const schemaType = type as JsonSchemaType
    const allowedFor: Record<string, JsonSchemaType[]> = {
      properties: ['object'],
      required: ['object'],
      additionalProperties: ['object'],
      items: ['array'],
      enum: ['string', 'number', 'integer', 'boolean', 'null'],
      const: ['string', 'number', 'integer', 'boolean', 'null'],
    }
    for (const [key, types] of Object.entries(allowedFor)) {
      if (Object.hasOwn(node, key) && !types.includes(schemaType)) {
        violations.push(`${path}.${key} is not supported on type "${schemaType}"`)
      }
    }

    switch (schemaType) {
      case 'object': {
        const properties = Object.hasOwn(node, 'properties') ? node.properties : undefined
        tasks.push({ kind: 'object-tail', node, path, properties })
        if (Object.hasOwn(node, 'properties')) {
          if (!isJsonSchemaRecord(properties)) {
            violations.push(`${path}.properties must be an object of schemas`)
          } else {
            const entries = Object.entries(properties)
            for (let index = entries.length - 1; index >= 0; index--) {
              const entry = entries[index]
              /* v8 ignore next -- the loop is bounded by the captured entry count. */
              if (entry === undefined) continue
              tasks.push({ kind: 'enter', node: entry[1], path: `${path}.properties.${entry[0]}` })
            }
          }
        }
        break
      }
      case 'array': {
        if (Object.hasOwn(node, 'items')) tasks.push({ kind: 'enter', node: node.items, path: `${path}.items` })
        break
      }
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null': {
        const hasEnum = Object.hasOwn(node, 'enum')
        const allowed = hasEnum ? node.enum : undefined
        const enumValid = isPlainJsonArray(allowed)
          && allowed.length > 0
          && allowed.every(entry => scalarMatches(schemaType, entry))
        if (hasEnum && !enumValid) {
          violations.push(`${path}.enum must be a non-empty array of ${schemaType} values`)
        }
        const hasConst = Object.hasOwn(node, 'const')
        const declaredConst = hasConst ? node.const : undefined
        const constValid = scalarMatches(schemaType, declaredConst)
        if (hasConst) {
          if (!constValid) {
            violations.push(`${path}.const must be a ${schemaType} value`)
          } else if (enumValid && !allowed.includes(declaredConst)) {
            violations.push(`${path}.const must be one of ${path}.enum when both are declared`)
          }
        }
        break
      }
      /* v8 ignore next -- schemaType was narrowed from the closed SCHEMA_TYPES table above. */
      default: assertNever(schemaType, 'JsonSchemaType')
    }
  }
}

/**
 * Assert that an arbitrary raw schema uses only the enforced subset.
 * Annotation-only schemas are accepted as the standard unconstrained-JSON
 * form; callers that require an object root use {@link assertObjectJsonSchema}.
 * @param schema - untrusted raw JSON Schema.
 * @returns Assertion that the schema belongs to the supported subset.
 */
export function assertSupportedJsonSchema(schema: unknown): asserts schema is JsonSchemaNode {
  const violations: string[] = []
  checkSchemaNode(schema, 'schema', violations, new Set())
  if (violations.length > 0) throw new JsonSchemaError(violations)
}

/**
 * Assert the enforced subset plus the object-root constraint retained by
 * subagent and workflow structured outputs.
 * @param schema - untrusted caller-supplied schema.
 * @returns Assertion that the schema belongs to the supported subset and has an object root.
 */
export function assertObjectJsonSchema(schema: unknown): asserts schema is ObjectJsonSchema {
  const violations: string[] = []
  checkSchemaNode(schema, 'schema', violations, new Set())
  if (violations.length === 0
    && (!isJsonSchemaRecord(schema) || !Object.hasOwn(schema, 'type') || schema.type !== 'object')) {
    violations.push('schema.type must be "object" (structured output is object-rooted)')
  }
  if (violations.length > 0) throw new JsonSchemaError(violations)
}

/** Safely test the lossless JSON boundary when a getter may throw. */
function safelyIsJsonValue(value: unknown): boolean {
  try {
    return isJsonValue(value)
  } catch {
    return false
  }
}

/** Root-aware diagnostic path for the parameter validator's empty sentinel. */
function diagnosticPath(path: string): string {
  return path === '' ? 'arguments' : path
}

/** Append one object property without a leading dot at an implicit root. */
function propertyPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

/** One child evaluation deferred by a container or exact-one union frame. */
interface ValueChild {
  readonly node: JsonSchemaNode
  readonly value: unknown
  readonly path: string
}

/** Explicit call frame for stack-safe schema-value validation. */
interface ValueFrame {
  readonly node: JsonSchemaNode
  readonly value: unknown
  readonly path: string
  catches: boolean
  phase: 'start' | 'children'
  kind?: 'oneOf' | 'object' | 'array'
  children: ValueChild[]
  childIndex: number
  violations: string[]
  tailViolations: string[]
  matches: number
}

/** The generic exception-containment diagnostic owned by one valid schema node. */
function losslessValueViolation(path: string): string[] {
  return [`"${diagnosticPath(path)}" must be a lossless JSON value`]
}

/** Append diagnostics without spreading a potentially wide child result as call arguments. */
function appendViolations(target: string[], source: readonly string[]): void {
  for (const violation of source) target.push(violation)
}

/** Initialize one validation frame with empty aggregation state. */
function valueFrame(node: JsonSchemaNode, value: unknown, path: string): ValueFrame {
  return {
    node,
    value,
    path,
    catches: false,
    phase: 'start',
    children: [],
    childIndex: 0,
    violations: [],
    tailViolations: [],
    matches: 0,
  }
}

/** Validate one scalar node after its primitive type check. */
function checkScalarValue(node: JsonSchemaNode, value: unknown, path: string): string[] {
  const allowed = Object.hasOwn(node, 'enum') ? node.enum : undefined
  if (allowed !== undefined && !allowed.includes(value as JsonSchemaScalar)) {
    return [`"${diagnosticPath(path)}" must be one of ${JSON.stringify(allowed)}`]
  }
  if (Object.hasOwn(node, 'const') && value !== node.const) {
    return [`"${diagnosticPath(path)}" must be ${JSON.stringify(node.const)}`]
  }
  return []
}

/** Validate one trusted schema/value pair with explicit frames rather than recursive calls. */
function checkValue(schema: JsonSchemaNode, value: unknown, path: string): string[] {
  const frames: ValueFrame[] = [valueFrame(schema, value, path)]
  let rootResult: string[] | undefined

  const receive = (result: string[]): void => {
    const parent = frames.at(-1)
    if (parent === undefined) {
      rootResult = result
      return
    }
    if (parent.kind === 'oneOf') {
      if (result.length === 0) parent.matches++
    } else {
      appendViolations(parent.violations, result)
    }
  }
  const finish = (result: string[]): void => {
    frames.pop()
    receive(result)
  }

  while (frames.length > 0) {
    const frame = frames.at(-1)
    /* v8 ignore next -- the loop condition guarantees a current frame. */
    if (frame === undefined) break
    try {
      if (frame.phase === 'children') {
        if (frame.childIndex < frame.children.length) {
          const child = frame.children[frame.childIndex]
          /* v8 ignore next -- childIndex is bounded by children.length. */
          if (child === undefined) throw new Error('missing schema-value child frame')
          frame.childIndex++
          frames.push(valueFrame(child.node, child.value, child.path))
          continue
        }
        if (frame.kind === 'oneOf') {
          finish(frame.matches === 1 ? [] : [`"${diagnosticPath(frame.path)}" must match exactly one oneOf branch (matched ${frame.matches})`])
          continue
        }
        appendViolations(frame.violations, frame.tailViolations)
        if (frame.violations.length > 0) {
          finish(frame.violations)
        } else if (frame.kind === 'object') {
          finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a lossless JSON object`])
        } else {
          finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a dense lossless JSON array`])
        }
        continue
      }

      const nodeType = Object.hasOwn(frame.node, 'type') ? frame.node.type : undefined
      frame.catches = !(nodeType !== undefined && !(SCHEMA_TYPES as readonly unknown[]).includes(nodeType))
      const oneOf = Object.hasOwn(frame.node, 'oneOf') ? frame.node.oneOf : undefined
      if (oneOf !== undefined) {
        frame.kind = 'oneOf'
        frame.children = Array.from(oneOf, branch => ({ node: branch, value: frame.value, path: frame.path }))
        frame.childIndex = 0
        frame.matches = 0
        frame.phase = 'children'
        continue
      }
      if (nodeType === undefined) {
        finish(safelyIsJsonValue(frame.value) ? [] : losslessValueViolation(frame.path))
        continue
      }

      switch (nodeType) {
        case 'object': {
          if (!isPlainJsonRecord(frame.value)) {
            finish([`"${diagnosticPath(frame.path)}" must be an object`])
            break
          }
          const properties = Object.hasOwn(frame.node, 'properties') ? frame.node.properties ?? {} : {}
          const violations: string[] = []
          const required = Object.hasOwn(frame.node, 'required') ? frame.node.required ?? [] : []
          for (const key of required) {
            if (!Object.hasOwn(frame.value, key) || frame.value[key] === undefined) {
              violations.push(`missing required property "${propertyPath(frame.path, key)}"`)
            }
          }
          const children: ValueChild[] = []
          for (const [key, child] of Object.entries(properties)) {
            if (!Object.hasOwn(frame.value, key) || frame.value[key] === undefined) continue
            children.push({ node: child, value: frame.value[key], path: propertyPath(frame.path, key) })
          }
          const tailViolations: string[] = []
          if (Object.hasOwn(frame.node, 'additionalProperties') && frame.node.additionalProperties === false) {
            for (const key of Object.keys(frame.value)) {
              if (!Object.hasOwn(properties, key)) {
                tailViolations.push(`"${propertyPath(frame.path, key)}" is not a declared property (additionalProperties: false)`)
              }
            }
          }
          frame.kind = 'object'
          frame.children = children
          frame.childIndex = 0
          frame.violations = violations
          frame.tailViolations = tailViolations
          frame.phase = 'children'
          break
        }
        case 'array': {
          if (!Array.isArray(frame.value)) {
            finish([`"${diagnosticPath(frame.path)}" must be an array`])
            break
          }
          const items = Object.hasOwn(frame.node, 'items') ? frame.node.items : undefined
          const children = items === undefined
            ? []
            : frame.value.flatMap((entry, index): ValueChild[] => [{ node: items, value: entry, path: `${frame.path}[${index}]` }])
          frame.kind = 'array'
          frame.children = children
          frame.childIndex = 0
          frame.violations = []
          frame.phase = 'children'
          break
        }
        case 'string':
          finish(typeof frame.value === 'string'
            ? checkScalarValue(frame.node, frame.value, frame.path)
            : [`"${diagnosticPath(frame.path)}" must be a string`])
          break
        case 'number':
          finish(typeof frame.value !== 'number'
            ? [`"${diagnosticPath(frame.path)}" must be a number`]
            : !isJsonNumber(frame.value)
              ? [`"${diagnosticPath(frame.path)}" must be a finite JSON number`]
              : checkScalarValue(frame.node, frame.value, frame.path))
          break
        case 'integer':
          finish(!isJsonNumber(frame.value) || !Number.isInteger(frame.value)
            ? [`"${diagnosticPath(frame.path)}" must be an integer`]
            : checkScalarValue(frame.node, frame.value, frame.path))
          break
        case 'boolean':
          finish(typeof frame.value === 'boolean'
            ? checkScalarValue(frame.node, frame.value, frame.path)
            : [`"${diagnosticPath(frame.path)}" must be a boolean`])
          break
        case 'null':
          finish(frame.value === null
            ? checkScalarValue(frame.node, frame.value, frame.path)
            : [`"${diagnosticPath(frame.path)}" must be null`])
          break
        default:
          finish(assertNever(nodeType, 'JsonSchemaType'))
      }
    } catch (error) {
      let failed = frames.pop()
      while (failed !== undefined && !failed.catches) failed = frames.pop()
      if (failed === undefined) throw error
      receive(losslessValueViolation(failed.path))
    }
  }

  /* v8 ignore next -- every root frame finishes or throws. */
  return rootResult ?? losslessValueViolation(path)
}

/**
 * Validate a candidate value against an asserted raw schema. The function is
 * total for arbitrary values and returns path-qualified violations.
 * @param schema - a schema accepted by {@link assertSupportedJsonSchema}.
 * @param value - the candidate JSON value.
 * @param path - root label used in diagnostics.
 * @returns All violations in walk order; empty means valid.
 */
export function validateJsonSchemaValue(schema: JsonSchemaNode, value: unknown, path = 'value'): string[] {
  return checkValue(schema, value, path)
}

/* -------------------------------------------------------------------------
 * Rendering-side widening
 *
 * {@link assertSupportedJsonSchema} is the enforcement boundary, and it rejects
 * anything it cannot enforce: a schema that reaches a validator must mean what
 * it says. Rendering asks a different question — which type should the model be
 * told to pass — and there the cost of rejection is wildly asymmetric. One leaf
 * keyword the subset does not enforce used to collapse a whole tool's argument
 * list to one opaque token, and under PTC mode that generated text is the
 * model's ONLY description of how to call a tool: a third-party MCP server's
 * `inputSchema` routinely carries `format`, `pattern`, or a `$ref`, so the model
 * was told which tools exist and nothing about how to call them, and declined.
 *
 * {@link widenJsonSchema} answers the rendering question instead. It reads every
 * construct the subset can express, resolves a local `$ref` against the document
 * it appears in, folds `anyOf`/`allOf`/type arrays/`nullable` into the shapes the
 * renderers already know, ignores the keywords that only refine a value the type
 * already describes, and widens anything left unreadable to the largest type
 * that still says something. The result is a trusted {@link JsonSchemaNode}, so
 * the renderers walk it exactly as they walked an asserted schema.
 * ---------------------------------------------------------------------- */

/** One raw node's rendering plan: a finished node, or the children still to walk. */
type WidenPlan =
  | { readonly kind: 'node'; readonly node: JsonSchemaNode }
  | {
    readonly kind: 'children'
    readonly children: readonly unknown[]
    readonly childChain: readonly string[]
    readonly assemble: (children: readonly JsonSchemaNode[]) => JsonSchemaNode
  }

/** One explicit frame of the stack-safe widening walk. */
interface WidenFrame {
  readonly raw: unknown
  /** `$ref` pointers already expanded above this frame; this is what terminates a recursive definition. */
  readonly chain: readonly string[]
  phase: 'start' | 'children'
  children: readonly unknown[]
  childChain: readonly string[]
  childIndex: number
  childResults: JsonSchemaNode[]
  assemble: ((children: readonly JsonSchemaNode[]) => JsonSchemaNode) | undefined
}

/** A frame before it is planned; the `start` phase fills the remaining fields. */
function widenFrame(raw: unknown, chain: readonly string[]): WidenFrame {
  return {
    raw,
    chain,
    phase: 'start',
    children: [],
    childChain: chain,
    childIndex: 0,
    childResults: [],
    assemble: undefined,
  }
}

/** A node's own documentation, which survives every widening decision. */
function annotationNode(record: Record<string, unknown>): JsonSchemaNode {
  const node: JsonSchemaNode = {}
  if (typeof record.description === 'string') node.description = record.description
  if (typeof record.title === 'string') node.title = record.title
  return node
}

/** Attach a node's own annotations to whatever its body widened to. */
function annotated(plan: WidenPlan, annotations: JsonSchemaNode): WidenPlan {
  if (plan.kind === 'node') return { kind: 'node', node: { ...annotations, ...plan.node } }
  return {
    kind: 'children',
    children: plan.children,
    childChain: plan.childChain,
    assemble: children => ({ ...annotations, ...plan.assemble(children) }),
  }
}

/** Attach a node's annotations and add the `null` branch a nullable node declares. */
function nullableShape(plan: WidenPlan, annotations: JsonSchemaNode): WidenPlan {
  const wrap = (node: JsonSchemaNode): JsonSchemaNode => ({ ...annotations, oneOf: [node, { type: 'null' }] })
  if (plan.kind === 'node') return { kind: 'node', node: wrap(plan.node) }
  return {
    kind: 'children',
    children: plan.children,
    childChain: plan.childChain,
    assemble: children => wrap(plan.assemble(children)),
  }
}

/** Assemble a plan that scheduled exactly one child. */
function firstChild(children: readonly JsonSchemaNode[]): JsonSchemaNode {
  /* v8 ignore next -- every caller narrows the list to one child first. */
  return children[0] ?? {}
}

/**
 * Resolve a `$ref` against the document root, or `undefined` when it names
 * nothing reachable. Only a local JSON pointer is followed: the subset fetches
 * no remote document, so a pointer that leaves the root is exactly as
 * unresolvable as a missing one.
 */
function resolveLocalRef(root: unknown, ref: string): unknown {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return undefined
  let current: unknown = root
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~')
    if (!isJsonSchemaRecord(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

/** The union branches a node declares, with `oneOf` and `anyOf` pooled in one list. */
function unionBranches(record: Record<string, unknown>): readonly unknown[] {
  const branches: unknown[] = []
  for (const candidate of [record.oneOf, record.anyOf]) {
    if (!Array.isArray(candidate)) continue
    for (const branch of candidate as unknown[]) branches.push(branch)
  }
  return branches
}

/** Whether a node carries the constraints an `allOf` fold — or a `$ref` sibling — would have to absorb. */
function hasShapeKeywords(record: Record<string, unknown>): boolean {
  return ['type', 'properties', 'required', 'additionalProperties', 'items', 'prefixItems', 'enum', 'const']
    .some(key => Object.hasOwn(record, key))
}

/**
 * The keywords a node declares beside its `$ref`. A pointer names another
 * schema; everything written next to it addresses the same value, and a
 * dialect that honours those siblings would otherwise lose them here.
 */
function withoutRef(record: Record<string, unknown>): Record<string, unknown> {
  const own: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key !== '$ref') own[key] = value
  }
  return own
}

/**
 * Fold every `allOf` branch into one object shape. A branch that widens to an
 * unconstrained node contributes nothing, which is the reading that keeps a
 * `$ref` this subset cannot resolve from erasing the branches beside it. An
 * intersection with a non-object branch is not expressible as a type, so the
 * whole fold widens rather than claiming one of its halves.
 */
function mergeObjects(children: readonly JsonSchemaNode[]): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {}
  const required: string[] = []
  let closed = false
  let typed = false
  for (const child of children) {
    if (child.oneOf !== undefined) return {}
    if (child.type === undefined) continue
    if (child.type !== 'object') return {}
    typed = true
    for (const [key, value] of Object.entries(child.properties ?? {})) {
      if (!Object.hasOwn(properties, key)) properties[key] = value
    }
    for (const key of child.required ?? []) {
      if (!required.includes(key)) required.push(key)
    }
    if (child.additionalProperties === false) closed = true
  }
  if (!typed) return {}
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
    ...(closed ? { additionalProperties: false } : {}),
  }
}

/**
 * The element type a tuple declaration implies: `prefixItems` names the type of
 * each position, so an array whose positions share one shape is homogeneous and
 * one whose positions differ is expressible only as the union of them.
 * Duplicate shapes collapse, because a union that lists the same type twice is
 * noise the model has to read for nothing.
 */
function elementOf(children: readonly JsonSchemaNode[]): JsonSchemaNode {
  const distinct: JsonSchemaNode[] = []
  const seen = new Set<string>()
  for (const child of children) {
    const key = JSON.stringify(child)
    if (seen.has(key)) continue
    seen.add(key)
    distinct.push(child)
  }
  if (distinct.length > 1) return { oneOf: distinct }
  return firstChild(distinct)
}

/** The scalar schema type a JSON value implies, or `undefined` for objects and arrays. */
function scalarTypeOf(value: unknown): JsonSchemaScalarType | undefined {
  if (value === null) return 'null'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  if (isJsonNumber(value)) return 'number'
  return undefined
}

/** How a raw node declares its type: one shape, several, or nothing usable. */
type DeclaredShape =
  | { readonly kind: 'shape'; readonly type: JsonSchemaType; readonly nullable: boolean }
  | { readonly kind: 'union'; readonly types: readonly JsonSchemaType[] }
  | { readonly kind: 'none' }

/**
 * Read the `type` a raw node declares — one name, an array of them, or the
 * draft-04-era `nullable` flag — ignoring names outside the subset. Several
 * shapes widen to a union, but ONE shape plus `null` stays that shape with a
 * `null` branch: that is what keeps an object's `properties` attached to the
 * half of the union that owns them, and it is how the widely generated
 * `{ type: ['object', 'null'], properties: … }` survives.
 */
function declaredShape(record: Record<string, unknown>): DeclaredShape {
  const declared = record.type
  const names: readonly unknown[] = typeof declared === 'string'
    ? [declared]
    : Array.isArray(declared) ? declared as unknown[] : []
  if (names.length === 0) return { kind: 'none' }
  const types: JsonSchemaType[] = []
  for (const name of names) {
    if (typeof name !== 'string' || !(SCHEMA_TYPES as readonly string[]).includes(name)) continue
    const type = name as JsonSchemaType
    if (!types.includes(type)) types.push(type)
  }
  if (types.length === 0) return { kind: 'none' }
  let shape: JsonSchemaType | undefined
  let shapes = 0
  for (const type of types) {
    if (type === 'null') continue
    shape = type
    shapes++
  }
  if (shapes === 1) {
    return { kind: 'shape', type: shape as JsonSchemaType, nullable: record.nullable === true || types.includes('null') }
  }
  if (shapes === 0) return { kind: 'shape', type: 'null', nullable: true }
  const nullable = record.nullable === true || types.includes('null')
  return { kind: 'union', types: nullable && !types.includes('null') ? [...types, 'null'] : types }
}

/** The `enum`/`const` a scalar node declares, dropping any entry its own type contradicts. */
function scalarConstraints(record: Record<string, unknown>, type: JsonSchemaScalarType): JsonSchemaNode {
  const node: JsonSchemaNode = { type }
  const declared = record.enum
  if (Array.isArray(declared)) {
    const allowed = declared as unknown[]
    if (allowed.length > 0 && allowed.every(entry => scalarMatches(type, entry))) node.enum = allowed as JsonSchemaScalar[]
  }
  if (scalarMatches(type, record.const)) node.const = record.const as JsonSchemaScalar
  return node
}

/**
 * The scalar node a `type`-less node's `enum`/`const` implies. A set that mixes
 * scalar types, or that holds an object or array, names no single scalar type
 * the subset can express; widening says so rather than picking one member.
 */
function inferredScalar(record: Record<string, unknown>): JsonSchemaNode | undefined {
  if (Object.hasOwn(record, 'const')) {
    const type = scalarTypeOf(record.const)
    if (type === undefined) return undefined
    return { type, const: record.const as JsonSchemaScalar }
  }
  const declared = record.enum
  if (!Array.isArray(declared)) return undefined
  const allowed = declared as unknown[]
  const type = scalarTypeOf(allowed[0])
  if (type === undefined) return undefined
  for (const entry of allowed) {
    if (!scalarMatches(type, entry)) return undefined
  }
  return { type, enum: allowed as JsonSchemaScalar[] }
}

/** Read one node whose declared shape is known, scheduling the children it nests. */
function planForType(record: Record<string, unknown>, type: JsonSchemaType, chain: readonly string[]): WidenPlan {
  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      return { kind: 'node', node: scalarConstraints(record, type) }
    case 'array': {
      const items = record.items
      if (isJsonSchemaRecord(items)) {
        return {
          kind: 'children',
          children: [items],
          childChain: chain,
          assemble: children => ({ type: 'array', items: firstChild(children) }),
        }
      }
      const prefix = record.prefixItems
      if (Array.isArray(prefix) && prefix.length > 0) {
        const tuple = prefix as unknown[]
        return {
          kind: 'children',
          children: tuple,
          childChain: chain,
          assemble: children => ({ type: 'array', items: elementOf(children) }),
        }
      }
      return { kind: 'node', node: { type: 'array' } }
    }
    case 'object': {
      const declared = record.properties
      const properties = isJsonSchemaRecord(declared) ? declared : {}
      const entries = Object.entries(properties)
      if (entries.length === 0) {
        return { kind: 'node', node: record.additionalProperties === false
          ? { type: 'object', additionalProperties: false }
          : { type: 'object' } }
      }
      const required: string[] = []
      if (Array.isArray(record.required)) {
        for (const key of record.required as unknown[]) {
          if (typeof key === 'string' && Object.hasOwn(properties, key) && !required.includes(key)) required.push(key)
        }
      }
      return {
        kind: 'children',
        children: entries.map(entry => entry[1]),
        childChain: chain,
        assemble: children => {
          const widened: Record<string, JsonSchemaNode> = {}
          for (let index = 0; index < entries.length; index++) {
            const entry = entries[index]
            const child = children[index]
            /* v8 ignore next -- entries and widened children correspond one-to-one. */
            if (entry === undefined || child === undefined) throw new Error('missing widened property')
            widened[entry[0]] = child
          }
          return {
            type: 'object',
            properties: widened,
            ...(required.length === 0 ? {} : { required }),
            ...(record.additionalProperties === false ? { additionalProperties: false } : {}),
          }
        },
      }
    }
    /* v8 ignore next -- JsonSchemaType is closed and the cases above cover it. */
    default: return assertNever(type, 'JsonSchemaType')
  }
}

/** Decide how one raw node is read, given the root a `$ref` resolves against. */
function planWidening(raw: unknown, root: unknown, chain: readonly string[]): WidenPlan {
  if (!isJsonSchemaRecord(raw)) return { kind: 'node', node: {} }
  const record = raw
  const annotations = annotationNode(record)

  const ref = record.$ref
  if (typeof ref === 'string') {
    const target = resolveLocalRef(root, ref)
    if (isJsonSchemaRecord(target) && !chain.includes(ref)) {
      const own = withoutRef(record)
      if (!hasShapeKeywords(own)) {
        return {
          kind: 'children',
          children: [target],
          childChain: [...chain, ref],
          assemble: children => ({ ...firstChild(children), ...annotations }),
        }
      }
      /* The referencing node constrains the same value its pointer names, so the
         two halves describe one shape: fold them rather than dropping whichever
         one the walk happened to reach second. */
      return {
        kind: 'children',
        children: [target, own],
        childChain: [...chain, ref],
        assemble: children => ({ ...annotations, ...mergeObjects(children) }),
      }
    }
    /* A pointer that names nothing reachable, or one already being expanded above:
       it expands to nothing, but this node's own keywords still describe the value
       it accepts, so read them below instead of erasing the whole node. */
  }

  const branches = unionBranches(record)
  if (branches.length === 1) {
    return {
      kind: 'children',
      children: branches,
      childChain: chain,
      assemble: children => ({ ...firstChild(children), ...annotations }),
    }
  }
  if (branches.length > 1) {
    return {
      kind: 'children',
      children: branches,
      childChain: chain,
      assemble: children => ({ ...annotations, oneOf: [...children] }),
    }
  }

  const declared = record.allOf
  if (Array.isArray(declared)) {
    const composed = declared as unknown[]
    if (composed.length > 0 && !hasShapeKeywords(record)) {
      return {
        kind: 'children',
        children: composed,
        childChain: chain,
        assemble: children => ({ ...annotations, ...mergeObjects(children) }),
      }
    }
    return { kind: 'node', node: annotations }
  }

  const shape = declaredShape(record)
  if (shape.kind === 'shape') {
    const plan = planForType(record, shape.type, chain)
    return shape.nullable && shape.type !== 'null' ? nullableShape(plan, annotations) : annotated(plan, annotations)
  }
  if (shape.kind === 'union') {
    return { kind: 'node', node: { ...annotations, oneOf: shape.types.map(type => ({ type })) } }
  }

  const inferred = inferredScalar(record)
  if (inferred !== undefined) return { kind: 'node', node: { ...annotations, ...inferred } }
  if (isJsonSchemaRecord(record.properties)) return annotated(planForType(record, 'object', chain), annotations)
  return { kind: 'node', node: annotations }
}

/**
 * Read an arbitrary raw schema as the enforced subset, for rendering only.
 *
 * The walk is stack-safe and answers every construct the renderers know, so a
 * tool description written against any dialect reaches the model with its
 * argument names, required fields, and types intact instead of one opaque
 * token. A `$ref` is expanded where it points and folded with the keywords
 * written beside it; a tuple's `prefixItems` become the array's element type.
 * Values that are not a schema at all widen to the annotation-only node — the
 * subset's "any JSON" form — rather than being rejected.
 *
 * Total for every JSON value. A hostile object whose accessors throw is not
 * JSON, and callers with an untrusted boundary keep their own containment.
 * @param schema - untrusted raw JSON Schema from any producer.
 * @returns The same schema read as the enforced subset.
 */
export function widenJsonSchema(schema: unknown): JsonSchemaNode {
  const frames: WidenFrame[] = [widenFrame(schema, [])]
  let result: JsonSchemaNode | undefined
  const finish = (node: JsonSchemaNode): void => {
    frames.pop()
    const parent = frames.at(-1)
    if (parent === undefined) result = node
    else parent.childResults.push(node)
  }

  while (frames.length > 0) {
    const frame = frames.at(-1)
    /* v8 ignore next -- the loop condition guarantees a current frame. */
    if (frame === undefined) break
    if (frame.phase === 'children') {
      if (frame.childIndex < frame.children.length) {
        const child = frame.children[frame.childIndex]
        /* v8 ignore next -- childIndex is bounded by children.length. */
        if (child === undefined) throw new Error('missing widen child')
        frame.childIndex++
        frames.push(widenFrame(child, frame.childChain))
        continue
      }
      const assemble = frame.assemble
      /* v8 ignore next -- every child phase frame was planned at start. */
      if (assemble === undefined) throw new Error('missing widen assembly')
      finish(assemble(frame.childResults))
      continue
    }
    const plan = planWidening(frame.raw, schema, frame.chain)
    if (plan.kind === 'node') {
      finish(plan.node)
      continue
    }
    frame.phase = 'children'
    frame.children = plan.children
    frame.childChain = plan.childChain
    frame.assemble = plan.assemble
  }

  /* v8 ignore next -- every root frame finishes. */
  return result ?? {}
}
