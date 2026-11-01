/** Left-sidebar main panel: every background evolution and self-repair the dual-core RSI daemon recorded. */
import { useSyncExternalStore } from 'react'
import type { RsiEvolutionEntry, RsiIncidentRecord } from '@deepseek-ai/dsh-experimental-dual-core-rsi/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ActivitySource } from './activity-source.ts'
import { NS } from './locales.ts'
import css from './RsiPanel.module.css'

/** Registration-side business face for the panel. */
export interface RsiPanelInjected {
  /** One shared activity source; the panel owns no transport state. */
  activity: ActivitySource
}

/** Full props for the sidebar main panel. */
export type RsiPanelProps = PropsRuntime<'main'>
  & InjectFace<RsiPanelInjected>
  & PropsLocale<typeof NS>

/** Format one adoption or repair instant in the viewer's locale. */
function formatInstant(at: number): string {
  return new Date(at).toLocaleString()
}

/** Format one improvement fraction as a signed percentage. */
function formatImprovement(fraction: number): string {
  const percent = (fraction * 100).toFixed(1)
  return fraction > 0 ? `+${percent}%` : `${percent}%`
}

/**
 * Render one evolution row: what changed, the evidence, and when the daemon adopted it.
 * @param props - the entry and localized copy.
 * @returns the rendered row.
 */
function EvolutionRow({ entry, t }: { entry: RsiEvolutionEntry; t: PropsLocale<typeof NS>['t'] }) {
  return (
    <li className={css.row}>
      <div className={css.rowHead}>
        <span className={css.rowTitle}>{entry.rationale}</span>
        <span className={css.rowMeta}>{formatInstant(entry.adoptedAt)}</span>
      </div>
      <div className={css.rowFacts}>
        <span>{t('evolution.improvement', { value: formatImprovement(entry.improvement) })}</span>
        <span>{t(`evolution.trigger.${entry.trigger}`)}</span>
        {entry.guidance.length > 0 ? <span>{t('evolution.guidance', { count: entry.guidance.length })}</span> : null}
        {entry.skills.length > 0 ? <span>{t('evolution.skills', { count: entry.skills.length })}</span> : null}
      </div>
      {entry.guidance.length > 0 ? (
        <ul className={css.lines}>
          {entry.guidance.map(line => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
      {entry.skills.length > 0 ? (
        <div className={css.skills}>{entry.skills.join(', ')}</div>
      ) : null}
    </li>
  )
}

/**
 * Render one repair row: what broke, which attempt, and how the daemon recovered.
 * @param props - the incident and localized copy.
 * @returns the rendered row.
 */
function RepairRow({ incident, t }: { incident: RsiIncidentRecord; t: PropsLocale<typeof NS>['t'] }) {
  const recovery = incident.recovery === 'retried'
    ? t('repair.recovery.retried', { ms: incident.retryAfterMs })
    : t('repair.recovery.deferred', { ms: incident.retryAfterMs })
  return (
    <li className={css.row}>
      <div className={css.rowHead}>
        <span className={css.rowTitle}>{t(`repair.kind.${incident.kind}`)}</span>
        <span className={css.rowMeta}>{formatInstant(incident.settledAt)}</span>
      </div>
      <div className={css.rowFacts}>
        <span>{t('repair.attempt', { n: incident.attempt })}</span>
        <span>{recovery}</span>
      </div>
      <div className={css.detail}>{incident.detail}</div>
    </li>
  )
}

/**
 * Render the daemon's background activity: the policy line, the evolution
 * list, and the repair list, with loading, error, and empty states.
 * @param props - the shared activity source and localized copy.
 * @returns the sidebar main panel.
 */
export function RsiPanel(props: RsiPanelProps) {
  const { activity, t } = props
  const snapshot = useSyncExternalStore(activity.subscribe, activity.getSnapshot)
  const view = snapshot.view
  return (
    <section className={css.panel} aria-label={t('title')}>
      <header className={css.head}>
        <h2 className={css.title}>{t('title')}</h2>
        {view === null ? null : (
          <p className={css.state}>
            {view.daemonEnabled ? t('daemon.on') : t('daemon.off')}
            {' · '}
            {view.mergePolicy === 'auto' ? t('policy.auto') : t('policy.consult')}
          </p>
        )}
      </header>
      {snapshot.status === 'loading' ? <p className={css.notice}>{t('loading')}</p> : null}
      {snapshot.status === 'error' ? (
        <div className={css.notice}>
          <p>{t('error', { message: snapshot.error })}</p>
          <button type="button" onClick={() => { void activity.refresh() }}>{t('retry')}</button>
        </div>
      ) : null}
      {snapshot.status === 'ready' && view !== null && view.evolutions.length === 0 && view.repairs.length === 0 ? (
        <p className={css.notice}>{t('empty')}</p>
      ) : null}
      {view === null ? null : (
        <div className={css.sections}>
          {view.evolutions.length === 0 ? null : (
            <section>
              <h3 className={css.section}>{t('section.evolutions')}</h3>
              <ul className={css.list}>
                {view.evolutions.map(entry => <EvolutionRow key={entry.cycleId} entry={entry} t={t} />)}
              </ul>
            </section>
          )}
          {view.repairs.length === 0 ? null : (
            <section>
              <h3 className={css.section}>{t('section.repairs')}</h3>
              <ul className={css.list}>
                {view.repairs.map(incident => <RepairRow key={incident.id} incident={incident} t={t} />)}
              </ul>
            </section>
          )}
        </div>
      )}
    </section>
  )
}
