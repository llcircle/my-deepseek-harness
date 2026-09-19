/** System-prompt section editor: language-separated replacements and the failure lessons. */

import { useEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginCard } from './PluginCard.tsx'
import type { PromptOverridesCardFace, ReflectionRow } from './prompt-overrides-card-controller.ts'
import type {} from './slot-contract.ts'
import css from './PromptOverridesCard.module.css'

/** Props the renderer binds for the prompt-overrides card. */
export type PromptOverridesCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<PromptOverridesCardFace>

/** 一条能力的类别标签；电脑操作没有名字，整行标题就是它的类别。 */
function kindLabelKey(
  kind: ReflectionRow['kind'],
): 'reflectionsKindTool' | 'reflectionsKindMcp' | 'reflectionsKindMcpTool' | 'reflectionsKindComputer' {
  if (kind === 'tool') return 'reflectionsKindTool'
  if (kind === 'mcp') return 'reflectionsKindMcp'
  if (kind === 'mcp-tool') return 'reflectionsKindMcpTool'
  return 'reflectionsKindComputer'
}

/** 介绍预览取当前语言那一栏，缺了就用另一栏——空着比给错语言好。 */
function introOf(row: ReflectionRow): string {
  return row.zh.trim() !== '' ? row.zh : row.en
}

/** Render the system-prompt overrides card. */
export function PromptOverridesCard(props: PromptOverridesCardProps) {
  const { t } = props
  const state = props.usePromptOverridesCard(snapshot => snapshot)
  useEffect(() => { props.refresh() }, [props.refresh])
  const correction = state.correction
  return (
    <PluginCard
      t={t}
      titleKey="promptOverridesTitle"
      descriptionKey="promptOverridesDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div className={css.group}>
        <label className={css.label} htmlFor="prompt-overrides-section">{t('promptOverridesSection')}</label>
        {state.sectionsStatus === 'loading' ? <p className={css.hint}>{t('promptOverridesLoading')}</p> : null}
        {state.sectionsStatus === 'error' && state.sectionsError !== undefined
          ? <p className={css.hint}>{t('promptOverridesLoadFailed', { error: state.sectionsError })}</p>
          : null}
        <div className={css.toolbar}>
          <select
            id="prompt-overrides-section"
            value={state.selectedSection}
            disabled={!state.writable}
            onChange={(event) => { props.selectSection(event.target.value) }}
          >
            {state.sectionNames.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        <label className={css.label} htmlFor="prompt-overrides-zh">{t('promptOverridesChineseEditor')}</label>
        <textarea
          id="prompt-overrides-zh"
          className={css.editor}
          value={state.selectedZh}
          disabled={!state.writable}
          onChange={(event) => { props.editSection('zh', event.target.value) }}
        />
        <label className={css.label} htmlFor="prompt-overrides-en">{t('promptOverridesEnglishEditor')}</label>
        <textarea
          id="prompt-overrides-en"
          className={css.editor}
          value={state.selectedEn}
          disabled={!state.writable}
          onChange={(event) => { props.editSection('en', event.target.value) }}
        />
        <p className={css.hint}>{t('promptOverridesLanguageHint')}</p>
      </div>
      <div className={css.group}>
        <div className={css.toolbar}>
          <label className={css.label} htmlFor="prompt-maintenance-errors">{t('toolErrorsTitle')}</label>
          <button type="button" onClick={() => { props.refresh() }}>{t('toolErrorsRefresh')}</button>
        </div>
        {state.toolErrorsStatus === 'loading' ? <p className={css.hint}>{t('toolErrorsLoading')}</p> : null}
        {state.toolErrorsStatus === 'error' && state.toolErrorsError !== undefined
          ? <p className={css.hint}>{t('toolErrorsLoadFailed', { error: state.toolErrorsError })}</p>
          : null}
        {state.toolErrors.length === 0 && state.toolErrorsStatus === 'ready'
          ? <p className={css.hint}>{t('toolErrorsEmpty')}</p>
          : null}
        {state.toolErrors.length > 0
          ? (
            <ul className={css.errorList}>
              {state.toolErrors.map(error => (
                <li key={`${error.sessionId}:${error.seq}`} className={css.errorItem}>
                  <div className={css.errorMeta}>
                    {error.time} · {error.name} · {error.callId}
                  </div>
                  <pre className={css.errorText}>{error.text}</pre>
                </li>
              ))}
            </ul>
          )
          : null}
      </div>
      <div className={css.group}>
        <div className={css.toolbar}>
          <span className={css.label}>{t('reflectionsLabel')}</span>
          <button type="button" onClick={() => { props.refresh() }}>{t('toolErrorsRefresh')}</button>
          <button
            type="button"
            disabled={correction.phase === 'running'}
            onClick={() => { props.runCorrection() }}
          >
            {correction.phase === 'running' ? t('reflectionsCorrecting') : t('reflectionsCorrect')}
          </button>
        </div>
        {correction.phase === 'done'
          ? (
            <>
              <p className={css.hint}>{t('reflectionsCorrected')}</p>
              {/* 命令自己的回执（"没有可纠正的错误" / "子代理已启动"）原样透出，
                  否则用户分不清是白跑了一趟还是真的派了活。 */}
              {correction.message === undefined
                ? null
                : <p className={css.hint}>{correction.message}</p>}
            </>
          )
          : null}
        {correction.phase === 'unavailable'
          ? <p className={css.hint}>{t('reflectionsCorrectNeedsSession')}</p>
          : null}
        {correction.phase === 'failed'
          ? <p className={css.hint}>{t('reflectionsCorrectFailed', { error: correction.error })}</p>
          : null}
        <p className={css.hint}>{t('reflectionsHint')}</p>
        {state.reflectionsStatus === 'loading' ? <p className={css.hint}>{t('reflectionsLoading')}</p> : null}
        {state.reflectionsStatus === 'error' && state.reflectionsError !== undefined
          ? <p className={css.hint}>{t('reflectionsLoadFailed', { error: state.reflectionsError })}</p>
          : null}
        {state.reflectionsStatus === 'ready' && state.reflectionRows.length === 0
          ? <p className={css.hint}>{t('reflectionsEmpty')}</p>
          : null}
        {state.reflectionRows.length > 0
          ? (
            <ul className={css.reflectionList}>
              {state.reflectionRows.map(row => (
                <li key={row.subject} className={css.reflectionItem}>
                  <div className={css.rowHead}>
                    <span className={css.rowName}>{row.label === '' ? t(kindLabelKey(row.kind)) : row.label}</span>
                    <span className={css.badge}>{t(kindLabelKey(row.kind))}</span>
                  </div>
                  {introOf(row) === ''
                    ? null
                    : (
                      <details className={css.intro}>
                        <summary>{t('reflectionsIntro')}</summary>
                        <pre className={css.preview}>{introOf(row)}</pre>
                      </details>
                    )}
                  <textarea
                    className={`${css.editor} ${css.rowEditor}`}
                    disabled={!state.writable}
                    value={row.text}
                    onChange={(event) => { props.editReflection(row.subject, event.target.value) }}
                  />
                </li>
              ))}
            </ul>
          )
          : null}
        {state.staleReflections > 0
          ? <p className={css.hint}>{t('reflectionsStale', { count: state.staleReflections })}</p>
          : null}
        {state.reflectionsFailed ? <p className={css.hint}>{t('reflectionsSaveFailed')}</p> : null}
        <div className={css.footer}>
          <button type="button" disabled={!state.reflectionsDirty || state.reflectionsSaving} onClick={() => { props.discardReflections() }}>
            {t('discard')}
          </button>
          <button type="button" disabled={!state.reflectionsDirty || state.reflectionsSaving} onClick={() => { props.saveReflections() }}>
            {state.reflectionsSaving ? t('saving') : t('save')}
          </button>
        </div>
      </div>
      <p className={css.hint}>{t('promptOverridesHint')}</p>
    </PluginCard>
  )
}
