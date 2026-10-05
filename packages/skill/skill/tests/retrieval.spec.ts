import { describe, expect, it } from 'vitest'
import {
  rankSkills,
  rankSkillSummaries,
  skillRankText,
  tokenizeForRanking,
  type SkillRankDocument,
  type SkillSummary,
} from '@deepseek-ai/dsh-skill'

/** A summary with the routing fields ranking reads and nothing else. */
function summary(name: string, description: string, whenToUse?: string): SkillSummary {
  return {
    name,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'user-dsh',
    provider: 'filesystem',
  }
}

/** A document whose searchable text is built the way the real callers build it. */
function documentOf(skill: SkillSummary): SkillRankDocument & { skill: SkillSummary } {
  return { name: skill.name, text: skillRankText(skill), skill }
}

describe('tokenizeForRanking', () => {
  it('lowercases space-separated words and drops punctuation', () => {
    expect(tokenizeForRanking('Read The GLOB-bench fixtures!')).toEqual([
      'read', 'the', 'glob', 'bench', 'fixtures',
    ])
  })

  it('splits underscored and dashed identifiers into their parts', () => {
    expect(tokenizeForRanking('web_fetch / easyeda-api')).toEqual([
      'web', 'fetch', 'easyeda', 'api',
    ])
  })

  it('reads a CJK run as overlapping character bigrams', () => {
    expect(tokenizeForRanking('画电路板')).toEqual(['画电', '电路', '路板'])
  })

  it('keeps a single-character CJK run whole', () => {
    expect(tokenizeForRanking('用 read')).toEqual(['read', '用'])
  })
})

describe('skillRankText', () => {
  it('spells the name out so a query written in words reaches it', () => {
    expect(skillRankText(summary('easyeda-api', 'Design boards.')))
      .toBe('easyeda-api easyeda api Design boards.')
  })

  it('appends the routing hint when there is one', () => {
    expect(skillRankText(summary('glob-bench', 'Run it.', 'when fixtures change')))
      .toBe('glob-bench glob bench Run it. when fixtures change')
  })

  it('omits the hint rather than leaving a gap when it is absent', () => {
    expect(skillRankText(summary('plain', 'No hint.'))).toBe('plain plain No hint.')
  })
})

describe('rankSkills', () => {
  const catalog: SkillSummary[] = [
    summary('easyeda-api', 'Drive EasyEDA Pro for schematic and PCB work.'),
    summary('stm32-probe', 'Recover a bricked STM32 board and a dead debug probe.'),
    summary('pdfkit-py', 'Read, merge, and fill PDF files from Python.'),
  ]

  it('returns nothing for an empty catalog or a non-positive limit', () => {
    expect(rankSkills([], 'anything', 5)).toEqual([])
    expect(rankSkills(catalog.map(documentOf), 'pdf', 0)).toEqual([])
    expect(rankSkills(catalog.map(documentOf), 'pdf', -1)).toEqual([])
  })

  it('ranks the document the query is about first', () => {
    const ranked = rankSkills(catalog.map(documentOf), 'merge PDF files', 3)
    expect(ranked.map(entry => entry.name)).toEqual(['pdfkit-py', 'easyeda-api', 'stm32-probe'])
  })

  it('finds a skill from the words its name is spelled with', () => {
    expect(rankSkills(catalog.map(documentOf), 'easyeda api', 1)[0]?.name).toBe('easyeda-api')
  })

  it('prefers a rare term over a common one', () => {
    const documents: SkillRankDocument[] = [
      { name: 'alpha', text: 'common' },
      { name: 'beta', text: 'common' },
      { name: 'gamma', text: 'common zebra' },
    ]
    expect(rankSkills(documents, 'zebra common', 1)[0]?.name).toBe('gamma')
  })

  it('prefers the shorter document when both hold the term once', () => {
    const documents: SkillRankDocument[] = [
      { name: 'short', text: 'alpha' },
      { name: 'long', text: `alpha ${Array.from({ length: 20 }, () => 'filler').join(' ')}` },
    ]
    expect(rankSkills(documents, 'alpha', 1)[0]?.name).toBe('short')
  })

  it('caps the result at the limit without dropping the best hit', () => {
    const ranked = rankSkills(catalog.map(documentOf), 'stm32 probe', 1)
    expect(ranked.map(entry => entry.name)).toEqual(['stm32-probe'])
  })

  it('still answers when no term occurs anywhere, in name order', () => {
    const documents: SkillRankDocument[] = [
      { name: 'charlie', text: 'nothing relevant' },
      { name: 'alpha', text: 'nothing relevant' },
      { name: 'bravo', text: 'nothing relevant' },
    ]
    expect(rankSkills(documents, '!!!', 2).map(entry => entry.name)).toEqual(['alpha', 'bravo'])
  })

  it('answers a query against documents that carry no terms at all', () => {
    const documents: SkillRankDocument[] = [
      { name: 'alpha', text: '' },
      { name: 'bravo', text: '' },
    ]
    expect(rankSkills(documents, 'anything', 2).map(entry => entry.name)).toEqual(['alpha', 'bravo'])
  })

  it('leaves the input array order untouched', () => {
    const documents = catalog.map(documentOf)
    rankSkills(documents, 'pdf', 3)
    expect(documents.map(entry => entry.name)).toEqual(['easyeda-api', 'stm32-probe', 'pdfkit-py'])
  })
})

describe('rankSkillSummaries', () => {
  it('hands back the summaries themselves, best first', () => {
    const catalog = [
      summary('easyeda-api', 'Drive EasyEDA Pro.'),
      summary('pdfkit-py', 'Merge and fill PDF files.'),
    ]
    expect(rankSkillSummaries(catalog, 'fill a pdf', 1).map(skill => skill.name)).toEqual(['pdfkit-py'])
  })

  it('returns nothing when the caller asks for no results', () => {
    expect(rankSkillSummaries([summary('only', 'One skill.')], 'only', 0)).toEqual([])
  })
})
