/**
 * 系统提示词覆盖卡片的控制器：分段预览、失败日志、分能力的经验，以及一键纠错。
 *
 * 这里守的第一条契约是「读取器只拿工作区，绝不拿调用点传来的东西」：曾几何时
 * 卡片把 `onClick={refresh}` 直接挂在按钮上，React 的点击事件被当成工作区路径
 * 一路送到宿主，参数校验把整次读取原样拒绝（`settings/readPromptSections
 * rejected "cwd"`）。`refresh()` 现在没有参数，这条测试盯住的就是它不会再把
 * 别的东西转出去。
 *
 * 第二条契约是「经验按能力分行，未装配的能力不出现」。名单来自**这次装配**的
 * 分段预览，而不是哪张编好的表：`mcp:github` 只有真挂了 github 服务器才存在，
 * `computer:policy` 只有启用电脑操作才注册。名单还包括分段**自己声明**的子主题：
 * 一个 MCP 服务器只有一节提示词，它的每个工具却在反思文档里各占一格，所以服务器
 * 那一行底下紧跟每个工具一行。文档里那些找不到对应能力的旧经验只被计数，既不显示
 * 也不会被保存动作顺手删掉。
 *
 * 第三条契约是「纠错按钮只负责按下」：融合、写文档、归档、清空日志全都由既有的
 * `/correct-errors` 命令承担，卡片不去维护第二份状态——经验文档由后台子代理稍后
 * 重写，用户点刷新才能看到新版。
 */

import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  PromptOverridesCardController,
  reflectionKindOf,
  type PromptOverridesCardDeps,
  type PromptOverridesSettings,
  type ReflectionBlockPreview,
} from '../src/client/prompt-overrides-card-controller.ts'

/** 一次装配里常见的一组分段：两个工具、一个 MCP 服务器（带两个工具），外加一段人格。 */
const LIVE_SECTIONS = [
  { name: 'deployment:persona-prefix', zh: '人格', en: 'Persona', editable: true, subjects: [] },
  { name: 'tool:read', zh: '用 read 读文件', en: 'Use read', editable: true, subjects: [] },
  { name: 'tool:write', zh: '用 write 写文件', en: 'Use write', editable: true, subjects: [] },
  {
    name: 'mcp:github',
    zh: '',
    en: 'This session has the MCP server "github" connected, providing: mcp__github__create_issue, mcp__github__search.',
    editable: true,
    subjects: ['mcp__github__create_issue', 'mcp__github__search'],
  },
  { name: 'computer:policy', zh: '', en: '', editable: false, subjects: [] },
]

/** A controller wired to a ready scope and a set of stubbed Host reads. */
function harness(overrides: Partial<PromptOverridesCardDeps> = {}) {
  const host = stubSettingsScope<PromptOverridesSettings>()
  host.publish({ status: 'ready', writable: true, revision: 1, value: {}, base: {}, user: {} })
  const deps: PromptOverridesCardDeps = {
    workspace: () => '/ws/one',
    readPromptSections: async () => LIVE_SECTIONS,
    readToolErrors: async () => [],
    readReflections: async () => [],
    writeReflections: async () => {},
    canRunCorrection: () => true,
    runCorrection: async () => {},
    ...overrides,
  }
  const controller = new PromptOverridesCardController(host.scope, deps)
  return { host, controller, face: controller.inject() }
}

/** The controller's current rendered state. */
function stateOf(face: ReturnType<PromptOverridesCardController['inject']>) {
  return face.hooks.promptOverridesCard.getSnapshot()
}

/** 刷新到就绪，省掉每个用例里重复的等待。 */
async function refreshed(face: ReturnType<PromptOverridesCardController['inject']>): Promise<void> {
  face.refresh()
  await vi.waitFor(() => { expect(stateOf(face).reflectionsStatus).toBe('ready') })
}

describe('reflectionKindOf', () => {
  it('recognizes the four ability families and nothing else', () => {
    expect(reflectionKindOf('tool:read')).toBe('tool')
    expect(reflectionKindOf('mcp:github')).toBe('mcp')
    expect(reflectionKindOf('mcp__github__search')).toBe('mcp-tool')
    expect(reflectionKindOf('computer:policy')).toBe('computer')
    // 前缀单独出现不算能力：没有名字就没有可称呼的对象。
    expect(reflectionKindOf('tool:')).toBeUndefined()
    expect(reflectionKindOf('mcp__github__')).toBeUndefined()
    expect(reflectionKindOf('deployment:persona-prefix')).toBeUndefined()
    expect(reflectionKindOf('computer:other')).toBeUndefined()
  })
})

describe('PromptOverridesCardController', () => {
  it('reads every document with the injected workspace and nothing else', async () => {
    const readPromptSections = vi.fn(async () => LIVE_SECTIONS)
    const { face, host } = harness({ readPromptSections })

    await refreshed(face)

    // 只传工作区：一个事件对象混进来就会被宿主的参数校验拒掉。
    expect(readPromptSections.mock.calls[0]).toEqual(['/ws/one'])
    // 可编辑列表里没有 computer:policy——它的正文是部署给出的安全边界，
    // 不是可润色的措辞；用户写的是同一行后面的经验。
    expect(stateOf(face).sectionNames).toEqual(['deployment:persona-prefix', 'mcp:github', 'tool:read', 'tool:write'])
    expect(host.scope.getSnapshot().status).toBe('ready')
  })

  it('lists one row per composed ability, carrying its introduction and lessons', async () => {
    const { face } = harness({
      readReflections: async () => [
        { subject: 'tool:read', text: '读大文件要先看行数' },
        { subject: 'tool:gone', text: '这条对应的工具已经不在了' },
      ],
    })

    await refreshed(face)

    const rows = stateOf(face).reflectionRows
    // 一个 MCP 服务器占多行：服务器自己一行，它声明的每个工具各一行，紧挨在一起。
    expect(rows.map(row => row.subject)).toEqual([
      'computer:policy',
      'mcp:github',
      'mcp__github__create_issue',
      'mcp__github__search',
      'tool:read',
      'tool:write',
    ])
    expect(rows.map(row => row.kind)).toEqual(['computer', 'mcp', 'mcp-tool', 'mcp-tool', 'tool', 'tool'])
    // 能力名字去掉类别前缀；电脑操作没有名字，交给界面按类别称呼；MCP 工具读成
    // "服务器 › 工具"，一行自己就能说清归属。
    expect(rows.map(row => row.label)).toEqual([
      '',
      'github',
      'github › create_issue',
      'github › search',
      'read',
      'write',
    ])
    // 介绍随行带上，用户能看见自己的经验会被追加到哪段话后面。
    expect(rows.find(row => row.subject === 'tool:read')?.zh).toBe('用 read 读文件')
    expect(rows.find(row => row.subject === 'mcp:github')?.en).toContain('"github"')
    // 工具行没有介绍可看：工具说明在工具 schema 里，不在系统提示词里。
    expect(rows.find(row => row.subject === 'mcp__github__search')?.en).toBe('')
    // 没写过的能力是空串，不是缺字段——界面据此渲染空输入框。
    expect(rows.find(row => row.subject === 'tool:write')?.text).toBe('')
    expect(rows.find(row => row.subject === 'mcp__github__search')?.text).toBe('')
    expect(rows.find(row => row.subject === 'tool:read')?.text).toBe('读大文件要先看行数')
  })

  it('keeps a tool\'s lessons editable while its server is still here', async () => {
    const { face } = harness({
      readReflections: async () => [
        { subject: 'mcp__github__deleted_tool', text: '这个工具已经下架了' },
      ],
    })

    await refreshed(face)

    // 注入按服务器前缀整块进行，这条经验照样发得出去，界面就没理由把它藏起来——
    // 藏起来等于用户再也改不动一段正在生效的提示词。它排在同服务器的那堆工具里
    // （按工具名排序），不会跑去别处。
    expect(stateOf(face).reflectionRows.map(row => row.subject)).toEqual([
      'computer:policy',
      'mcp:github',
      'mcp__github__create_issue',
      'mcp__github__deleted_tool',
      'mcp__github__search',
      'tool:read',
      'tool:write',
    ])
    expect(stateOf(face).staleReflections).toBe(0)
  })

  it('drops the computer row when the section is absent, counting its lessons as stale', async () => {
    // 未启用电脑操作的会话里 `computer:policy` 根本没注册（策略与工具同生共死），
    // 所以卡片上不该留一行空的"电脑操作"，文档里留着的那条旧经验按"没有对应能力"计数。
    const { face } = harness({
      readPromptSections: async () => LIVE_SECTIONS.filter(section => section.name !== 'computer:policy'),
      readReflections: async () => [{ subject: 'computer:policy', text: '上次点错了坐标' }],
    })

    await refreshed(face)

    expect(stateOf(face).reflectionRows.map(row => row.subject))
      .toEqual(['mcp:github', 'mcp__github__create_issue', 'mcp__github__search', 'tool:read', 'tool:write'])
    expect(stateOf(face).staleReflections).toBe(1)
  })

  it('counts lessons whose ability is not composed instead of listing them', async () => {
    const { face } = harness({
      readReflections: async () => [
        { subject: 'tool:gone', text: '旧工具的经验' },
        { subject: 'mcp:retired', text: '旧服务器的经验' },
      ],
    })

    await refreshed(face)

    // 不显示：界面只回答"这个会话里有什么"。也不删：用户没看见的东西不能被顺手清掉。
    expect(stateOf(face).reflectionRows.every(row => row.text === '')).toBe(true)
    expect(stateOf(face).staleReflections).toBe(2)
  })

  it('publishes the journaled failures beside the lessons', async () => {
    const { face } = harness({
      readToolErrors: async () => [
        { time: 't', sessionId: 's', seq: 1, name: 'computer_drag', callId: 'c', text: 'drag 需要 fromX/fromY' },
      ],
    })

    await refreshed(face)

    expect(stateOf(face).toolErrors).toHaveLength(1)
    expect(stateOf(face).toolErrorsStatus).toBe('ready')
    expect(stateOf(face).reflectionsDirty).toBe(false)
    expect(stateOf(face).correction).toEqual({ phase: 'idle' })
  })

  it('reports one failure for every document when a read rejects', async () => {
    const { face } = harness({
      readPromptSections: async () => { throw new Error('settings/readPromptSections rejected "cwd"') },
    })

    face.refresh()
    await vi.waitFor(() => { expect(stateOf(face).sectionsStatus).toBe('error') })

    const state = stateOf(face)
    expect(state.sectionsError).toContain('rejected "cwd"')
    expect(state.toolErrorsStatus).toBe('error')
    expect(state.reflectionsStatus).toBe('error')
  })

  it('sends only the subjects the user actually edited', async () => {
    const writeReflections = vi.fn(async (_blocks: readonly ReflectionBlockPreview[]) => {})
    const { face } = harness({
      readReflections: async () => [{ subject: 'tool:read', text: '旧经验' }],
      writeReflections,
    })

    await refreshed(face)
    // 点开又改回原样不算改动：一次没有内容的保存不该产生。
    face.editReflection('tool:read', '旧经验')
    expect(stateOf(face).reflectionsDirty).toBe(false)

    face.editReflection('tool:read', '新经验')
    face.editReflection('tool:write', '写文件要先确认路径')
    expect(stateOf(face).reflectionsDirty).toBe(true)

    face.saveReflections()
    await vi.waitFor(() => { expect(writeReflections).toHaveBeenCalledTimes(1) })

    // 只送改过的那两条：文档里其它主题界面从没显示过，没资格替用户删。
    expect(writeReflections.mock.calls[0]?.[0]).toEqual([
      { subject: 'tool:read', text: '新经验' },
      { subject: 'tool:write', text: '写文件要先确认路径' },
    ])
    await vi.waitFor(() => { expect(stateOf(face).reflectionsDirty).toBe(false) })
    expect(stateOf(face).reflectionRows.find(row => row.subject === 'tool:read')?.text).toBe('新经验')
  })

  it('keeps the draft when a lesson save rejects', async () => {
    const { face } = harness({
      writeReflections: async () => { throw new Error('只读') },
    })

    await refreshed(face)
    face.editReflection('tool:read', '草稿')
    face.saveReflections()
    await vi.waitFor(() => { expect(stateOf(face).reflectionsFailed).toBe(true) })

    expect(stateOf(face).reflectionsDirty).toBe(true)
    expect(stateOf(face).reflectionRows.find(row => row.subject === 'tool:read')?.text).toBe('草稿')

    face.discardReflections()
    expect(stateOf(face).reflectionsDirty).toBe(false)
    expect(stateOf(face).reflectionRows.find(row => row.subject === 'tool:read')?.text).toBe('')
  })

  it('hands the correction pass to the deployment and leaves local documents alone', async () => {
    const runCorrection = vi.fn(async () => 'Correction child cmd-1 started in the background.')
    const { face } = harness({ runCorrection })

    await refreshed(face)
    // 用户改了草稿：纠错不动它，因为文档是后台任务稍后重写的。
    face.editReflection('tool:read', '还没保存的草稿')

    face.runCorrection()
    expect(stateOf(face).correction).toEqual({ phase: 'running' })
    await vi.waitFor(() => { expect(stateOf(face).correction.phase).toBe('done') })

    expect(runCorrection).toHaveBeenCalledTimes(1)
    // 命令的回执要透到卡片上：是白跑一趟还是真派了活，只有命令自己知道。
    expect(stateOf(face).correction).toEqual({
      phase: 'done',
      message: 'Correction child cmd-1 started in the background.',
    })
    // 不动文档、不动草稿、也不去猜后台任务的结果——刷新才是唯一的同步入口。
    expect(stateOf(face).reflectionsDirty).toBe(true)
    expect(stateOf(face).reflectionRows.find(row => row.subject === 'tool:read')?.text).toBe('还没保存的草稿')
  })

  it('reports unavailable without running anything when no session is open', async () => {
    const runCorrection = vi.fn(async () => 'should never run')
    const { face } = harness({ canRunCorrection: () => false, runCorrection })

    face.runCorrection()
    await vi.waitFor(() => { expect(stateOf(face).correction).toEqual({ phase: 'unavailable' }) })

    expect(runCorrection).not.toHaveBeenCalled()
  })

  it('surfaces the failure text when the correction pass rejects', async () => {
    const { face } = harness({
      runCorrection: async () => { throw new Error('会话已结束') },
    })

    face.runCorrection()
    await vi.waitFor(() => { expect(stateOf(face).correction.phase).toBe('failed') })

    expect(stateOf(face).correction).toEqual({ phase: 'failed', error: '会话已结束' })
  })

  it('writes only section edits when the overrides are saved', async () => {
    const { host, face } = harness()
    host.mutate.mockResolvedValue(undefined)

    await refreshed(face)
    face.editSection('en', 'replacement')
    expect(stateOf(face).dirty).toBe(true)

    face.save()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalled() })

    // 写回去的只有分段目录与分段覆盖：经验走的是另一份文档，不挤在设置里。
    const ops = host.mutate.mock.calls[0]?.[0] as readonly { path: string[] }[]
    expect(ops.map(operation => operation.path.join('.'))).toEqual(['sectionCatalog', 'sections'])
  })
})
