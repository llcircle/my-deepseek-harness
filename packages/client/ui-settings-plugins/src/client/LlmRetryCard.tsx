/**
 * The llm-deepseek retry card: retry mode select plus, in normal mode, the
 * retry count; saved as one nested mutation.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginCard } from './PluginCard.tsx'
import { RETRY_MODES, type LlmRetryCardFace, type RetryModeValue } from './llm-retry-card-controller.ts'
import type {} from './slot-contract.ts'
import css from './SkillTriggerCard.module.css'

/** Locale key per retry mode, in the select's order. */
const MODE_LABEL_KEYS: Record<RetryModeValue, 'llmRetryModeNormal' | 'llmRetryModeAlways'> = {
  normal: 'llmRetryModeNormal',
  always: 'llmRetryModeAlways',
}

/** Props the renderer binds for the retry card. */
export type LlmRetryCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<LlmRetryCardFace>

/**
 * Render the retry card.
 * @param props - locale copy, the card snapshot, and its staged actions.
 * @returns the card.
 */
export function LlmRetryCard(props: LlmRetryCardProps) {
  const { t } = props
  const state = props.useLlmRetryCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="llmRetryTitle"
      descriptionKey="llmRetryDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div className={css.row}>
        <select
          className={css.input}
          value={state.mode}
          disabled={!state.writable}
          aria-label={t('llmRetryModeLabel')}
          onChange={(event) => { props.editMode(event.target.value) }}
        >
          {RETRY_MODES.map(value => (
            <option key={value} value={value}>{t(MODE_LABEL_KEYS[value])}</option>
          ))}
        </select>
        {state.mode === 'normal'
          ? (
            <input
              type="number"
              min={0}
              className={state.maxRetriesInvalid ? css.inputInvalid : css.input}
              value={state.maxRetries === undefined ? '' : String(state.maxRetries)}
              placeholder="5"
              disabled={!state.writable}
              aria-label={t('llmRetryMaxRetries')}
              onChange={(event) => { props.editMaxRetries(event.target.value) }}
            />
          )
          : null}
      </div>
      <p className={css.hint}>{state.mode === 'normal' ? t('llmRetryNormalHint') : t('llmRetryAlwaysHint')}</p>
    </PluginCard>
  )
}
