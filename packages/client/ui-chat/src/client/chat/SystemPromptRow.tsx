<<<<<<< ours
=======
<<<<<<< ours
>>>>>>> theirs
import { memo, useState } from 'react'
import type { ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import { DisclosureRow, IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { OpaqueBody } from './ContextBody.tsx'
import type { SystemPromptSection } from '../contract/chat-nodes.ts'
import css from './ContextInjectionRow.module.css'

/** Props for one complete system prompt disclosure. */
export interface SystemPromptRowProps {
  /** Model-visible prompt text behind every row; a change list still reports it whole. */
  text: string
  /** Source-preserving sections used for grouped display, tagged when they are a difference. */
  sections?: readonly SystemPromptSection[]
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

/** Locale key naming what happened to one section of a mid-session change. */
const SECTION_CHANGE_KEYS = {
  added: 'message.systemPrompt.added',
  updated: 'message.systemPrompt.updated',
  removed: 'message.systemPrompt.removed',
} as const

/**
 * Render one complete system prompt as a collapsed disclosure whose expanded
 * body is the same opaque context chrome: 141px code-block scrollport and
 * model-facing text with its real line breaks.
 *
 * A row that belongs to a change list carries the word for what moved beside
 * its name: a list of one row out of twenty-four has to say why it is short.
 * @param props - Complete prompt text and the locale seat.
 * @returns The system-prompt disclosure row.
 */
function PromptSectionRow({ section, t }: {
  section: SystemPromptSection
  t: ChatViewSlotProps['t']
}) {
  const [open, setOpen] = useState(false)
  return (
    <DisclosureRow
      className={css.root}
      icon={<IconBrowseOutline16 size={14} />}
      chevronClassName={css.chevron}
      title={section.name}
      collapsedContent={section.change === undefined
        ? undefined
        : (
          /* The context rows' separator shape, so a row that names a change
             reads as one line in the same 24px rhythm as its neighbours. */
          <>
            <span className={css.sep} aria-hidden />
            <span className={css.sectionChange} data-system-prompt-change={section.change}>
              {t(SECTION_CHANGE_KEYS[section.change])}
            </span>
          </>
        )}
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(value => !value) }}
    >
      <div className={css.body} data-system-prompt-body>
        <OpaqueBody content={[{ type: 'text', text: section.text }]} source={null} t={t} />
      </div>
    </DisclosureRow>
  )
}

export function SystemPromptRow({ text, sections, t }: SystemPromptRowProps) {
  const [open, setOpen] = useState(false)
  if (sections !== undefined && sections.length > 0) {
    return (
      <>
        {sections.map(section => <PromptSectionRow key={section.name} section={section} t={t} />)}
      </>
    )
  }
  return (
    <DisclosureRow
      className={css.root}
      icon={<IconBrowseOutline16 size={14} />}
      chevronClassName={css.chevron}
      title={t('message.systemPrompt')}
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(value => !value) }}
    >
      <div className={css.body} data-system-prompt-body>
        <OpaqueBody content={[{ type: 'text', text }]} source={null} t={t} />
      </div>
    </DisclosureRow>
  )
}

/** System-prompt keyed Chat renderer. */
export const SystemPromptNodeView = memo(function SystemPromptNodeView({
  node, t,
}: Pick<ChatNodeViewProps<'system-prompt'>, 'node' | 't'>) {
  return <SystemPromptRow
    text={node.data.text}
    {...node.data.sections === undefined ? {} : { sections: node.data.sections }}
    t={t}
  />
})
<<<<<<< ours
=======
=======
import { memo, useState } from 'react'
import type { ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import { DisclosureRow, IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { OpaqueBody } from './ContextBody.tsx'
import css from './ContextInjectionRow.module.css'

/** Props for one complete system prompt disclosure. */
export interface SystemPromptRowProps {
  /** Complete model-visible prompt text. */
  text: string
  /** True when the prompt replaced an earlier one from this position in the history. */
  update?: boolean
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

/**
 * Render one complete system prompt as a collapsed disclosure whose expanded
 * body is the same opaque context chrome: 141px code-block scrollport and
 * model-facing text with its real line breaks. An in-history update uses the
 * same row under its own title.
 * @param props - Complete prompt text, whether it is an update, and the locale seat.
 * @returns The system-prompt disclosure row.
 */
export function SystemPromptRow({ text, update = false, t }: SystemPromptRowProps) {
  const [open, setOpen] = useState(false)
  return (
    <DisclosureRow
      className={css.root}
      icon={<IconBrowseOutline16 size={14} />}
      chevronClassName={css.chevron}
      title={t(update ? 'message.systemPromptUpdate' : 'message.systemPrompt')}
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(value => !value) }}
    >
      <div className={css.body} data-system-prompt-body>
        <OpaqueBody content={[{ type: 'text', text }]} source={null} t={t} />
      </div>
    </DisclosureRow>
  )
}

/** System-prompt keyed Chat renderer. */
export const SystemPromptNodeView = memo(function SystemPromptNodeView({
  node, t,
}: Pick<ChatNodeViewProps<'system-prompt'>, 'node' | 't'>) {
  return <SystemPromptRow text={node.data.text} update={node.data.update === true} t={t} />
})
>>>>>>> theirs
>>>>>>> theirs
