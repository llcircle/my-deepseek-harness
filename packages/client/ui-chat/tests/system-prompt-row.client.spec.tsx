// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { SystemPromptNodeView } from '../src/client/chat/SystemPromptRow.tsx'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

describe('SystemPromptNodeView', () => {
  it('mounts the opaque context body only while its row is expanded', () => {
    const text = '# Agent rules\n\n- Read first\n- **Act carefully**'
    const node: ChatNode<'system-prompt'> = {
      key: 'request-prompt:1',
      kind: 'system-prompt',
      id: '1',
      target: 'chat',
      anchorSeq: 1,
      location: { kind: 'unresolved' },
      visibility: 'visible',
      data: { text },
    }
    const { container } = render(<SystemPromptNodeView
      node={node}
      t={makeTranslate(en)}
    />)

    const disclosure = screen.getByRole('button', { name: 'System prompt' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-system-prompt-body]')).toBeNull()
    expect(container.querySelector('[data-context-text]')).toBeNull()

    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-system-prompt-body]')).not.toBeNull()
    expect(container.querySelector('[data-context-text]')?.textContent).toBe(text)
    expect(screen.queryByRole('heading', { name: 'Agent rules' })).toBeNull()

    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-system-prompt-body]')).toBeNull()
  })

  it('groups newer source-preserving prompt sections without changing their text', () => {
    const node: ChatNode<'system-prompt'> = {
      key: 'request-prompt:2', kind: 'system-prompt', id: '2', target: 'chat', anchorSeq: 2,
      location: { kind: 'unresolved' }, visibility: 'visible',
      data: {
        text: '基础提示词\n\n技能目录',
        sections: [
          { name: 'deployment:translated-prompt', text: '基础提示词' },
          { name: 'skills:catalog', text: '技能目录' },
        ],
      },
    }
    const { container } = render(<SystemPromptNodeView node={node} t={makeTranslate(en)} />)
    const rows = screen.getAllByRole('button')
    expect(rows.map(row => row.textContent)).toEqual(['deployment:translated-prompt', 'skills:catalog'])
    expect(container.querySelectorAll('[data-system-prompt-change]')).toHaveLength(0)
    fireEvent.click(rows[1]!)
    expect(container.querySelectorAll('[data-system-prompt-body]')).toHaveLength(1)
    expect(container.querySelector('[data-context-text]')?.textContent).toBe('技能目录')
  })

  it('names what moved on the rows of a mid-session change', () => {
    const node: ChatNode<'system-prompt'> = {
      key: 'request-prompt:3', kind: 'system-prompt', id: '3', target: 'chat', anchorSeq: 3,
      location: { kind: 'unresolved' }, visibility: 'visible',
      data: {
        text: '# Persona\n\nclick things\n\ngraph tools',
        sections: [
          { name: 'deployment:persona-prefix', text: '# Persona', change: 'updated' },
          { name: 'computer:policy', text: 'click things', change: 'added' },
          { name: 'mcp:gone', text: '', change: 'removed' },
        ],
      },
    }
    const { container } = render(<SystemPromptNodeView node={node} t={makeTranslate(en)} />)

    const badges = [...container.querySelectorAll('[data-system-prompt-change]')]
    expect(badges.map(badge => badge.getAttribute('data-system-prompt-change')))
      .toEqual(['updated', 'added', 'removed'])
    expect(badges.map(badge => badge.textContent)).toEqual(['updated', 'added', 'removed'])
    // A removed section has no text left to show; the row still names it.
    expect(screen.getByRole('button', { name: /mcp:gone/ })).toBeTruthy()
  })

  it('titles an in-history prompt update as an update of the same row', () => {
    const node: ChatNode<'system-prompt'> = {
      key: 'system-message:10',
      kind: 'system-prompt',
      id: '10',
      target: 'chat',
      anchorSeq: 10,
      location: { kind: 'unresolved' },
      visibility: 'visible',
      data: { text: '# Updated rules', update: true },
    }
    const { container } = render(<SystemPromptNodeView node={node} t={makeTranslate(en)} />)

    const disclosure = screen.getByRole('button', { name: 'System prompt update' })
    fireEvent.click(disclosure)
    expect(container.querySelector('[data-context-text]')?.textContent).toBe('# Updated rules')
  })
})
