/**
 * The skill-trigger card: one staged row per override (skill name + state),
 * written as the whole dict when saved.
 */

import { useEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginCard } from './PluginCard.tsx'
import {
  SKILL_TRIGGER_STATES, type SkillTriggerCardFace, type SkillTriggerStateValue,
} from './skill-trigger-card-controller.ts'
import type {} from './slot-contract.ts'
import css from './SkillTriggerCard.module.css'

/** Locale key per trigger state, in the select's order. */
const STATE_LABEL_KEYS: Record<SkillTriggerStateValue, 'skillTriggerStatePassive' | 'skillTriggerStateActiveOnly' | 'skillTriggerStateIgnored'> = {
  passive: 'skillTriggerStatePassive',
  'active-only': 'skillTriggerStateActiveOnly',
  ignored: 'skillTriggerStateIgnored',
}

/** Props the renderer binds for the skill-trigger card. */
export type SkillTriggerCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<SkillTriggerCardFace>

/**
 * Render the skill-trigger card.
 * @param props - locale copy, the card snapshot, and its row actions.
 * @returns the card.
 */
export function SkillTriggerCard(props: SkillTriggerCardProps) {
  const { t } = props
  const state = props.useSkillTriggerCard(snapshot => snapshot)
  useEffect(() => { props.refresh() }, [props.refresh])
  return (
    <PluginCard
      t={t}
      titleKey="skillTriggerTitle"
      descriptionKey="skillTriggerDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div className={css.scopeBar} role="group" aria-label={t('skillTriggerScopeLabel')}>
        <button
          type="button"
          className={state.scope === 'global' ? css.scopeActive : css.scope}
          disabled={!state.writable}
          aria-pressed={state.scope === 'global'}
          onClick={() => { props.setScope('global') }}
        >
          {t('skillTriggerScopeGlobal')}
        </button>
        <button
          type="button"
          className={state.scope === 'project' ? css.scopeActive : css.scope}
          disabled={!state.writable || state.workspace === undefined}
          aria-pressed={state.scope === 'project'}
          onClick={() => { props.setScope('project') }}
        >
          {t('skillTriggerScopeProject')}
        </button>
      </div>
      {state.scope === 'project' && state.workspace !== undefined
        ? <p className={css.workspace}>{t('skillTriggerWorkspace', { workspace: state.workspace })}</p>
        : null}
      {state.scope === 'project' && state.workspace === undefined
        ? <p className={css.empty}>{t('skillTriggerNoWorkspace')}</p>
        : null}
      {state.skillsStatus === 'loading' ? <p className={css.empty}>{t('skillTriggerLoading')}</p> : null}
      {state.skillsStatus === 'error' && state.skillsError !== undefined
        ? <p className={css.invalidHint}>{t('skillTriggerLoadFailed', { error: state.skillsError })}</p>
        : null}
      {state.rows.length === 0 ? <p className={css.empty}>{t('skillTriggerEmpty')}</p> : null}
      <ul className={css.rows}>
        {state.rows.map((row, index) => (
          <li key={index} className={css.row}>
            <input
              type="text"
              className={row.invalid ? css.inputInvalid : css.input}
              value={row.name}
              placeholder={t('skillTriggerNamePlaceholder')}
              disabled={!state.writable}
              aria-label={t('skillTriggerNameLabel')}
              onChange={(event) => { props.editRowName(index, event.target.value) }}
            />
            <select
              className={css.input}
              value={row.state}
              disabled={!state.writable}
              aria-label={t('skillTriggerStateLabel')}
              onChange={(event) => { props.editRowState(index, event.target.value) }}
            >
              {SKILL_TRIGGER_STATES.map(value => (
                <option key={value} value={value}>{t(STATE_LABEL_KEYS[value])}</option>
              ))}
            </select>
            <button
              type="button"
              className={css.remove}
              disabled={!state.writable}
              aria-label={t('skillTriggerRemove')}
              onClick={() => { props.removeRow(index) }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {state.rows.some(row => row.invalid) ? <p className={css.invalidHint}>{t('skillTriggerInvalidName')}</p> : null}
      <button type="button" className={css.add} disabled={!state.writable} onClick={props.addRow}>
        {t('skillTriggerAdd')}
      </button>
      <p className={css.hint}>{t('skillTriggerHint')}</p>
    </PluginCard>
  )
}
