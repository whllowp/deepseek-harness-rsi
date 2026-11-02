/**
 * The pixel-hero companion sprite: an original hand-drawn pixel hero in the
 * adventure-RPG tradition that walks the bottom of the window, hums while a
 * daemon cycle runs, flashes when the daemon records a self-repair, and
 * raises a heart when the daemon adopts an evolution.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ActivitySource } from '@deepseek-ai/dsh-experimental-client-ui-rsi/client'
import type { RsiActivityView } from '@deepseek-ai/dsh-experimental-dual-core-rsi/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { foldHeroState, type HeroPose, type HeroState } from './pet-state.ts'
import css from './ZeldaPet.module.css'
import { NS } from './locales.ts'

/** Registration-side business face for the companion. */
export interface ZeldaPetInjected {
  /** One shared activity source; the hero owns no transport state. */
  activity: ActivitySource
  /** Open the Self-evolution sidebar panel; guarded by its registration. */
  openSelfEvolution: () => void
}

/** Full props for the companion component. */
export type ZeldaPetProps = PropsLocale<typeof NS>
  & { inject: ZeldaPetInjected }

/** Milliseconds a transient reaction pose stays before falling back to idle. */
const REACTION_MS = 2_500

/**
 * Render the hero companion from the daemon's activity stream.
 * @param props - the shared activity source, the panel opener, and copy.
 * @returns the walking hero with its pose and speech bubble.
 */
export function ZeldaPet(props: ZeldaPetProps) {
  const { activity, openSelfEvolution } = props.inject
  const { t } = props
  const snapshot = useSyncExternalStore(activity.subscribe, activity.getSnapshot)
  const seenView = useRef<RsiActivityView | undefined>(undefined)
  const fold = (): HeroState => foldHeroState(seenView.current, snapshot, {
    evolution: rationale => t('bubble.evolution', { rationale }),
    repair: detail => t('bubble.repair', { detail }),
    empty: () => t('bubble.empty'),
  })
  const [hero, setHero] = useState<HeroState>(fold)

  useEffect(() => {
    const next = fold()
    if (snapshot.status === 'ready') seenView.current = snapshot.view
    setHero(next)
    if (next.pose === 'hurt' || next.pose === 'levelUp') {
      const timer = setTimeout(() => {
        // Any snapshot change re-runs this effect and clears the timer, so a
        // firing timer implies the transient pose is still current.
        setHero(current => ({ ...current, pose: 'idle' }))
      }, REACTION_MS)
      return () => { clearTimeout(timer) }
    }
    return undefined
  }, [snapshot, t])

  const bubbleText = hero.bubble.kind !== 'empty' ? hero.bubble.text : (hero.pose === 'idle' ? hero.bubble.text : '')
  return (
    <div className={css.companion} data-hero-pose={hero.pose} data-hero-active={hero.active ? 'true' : 'false'}>
      <output className={css.bubble} data-hero-bubble={hero.bubble.kind}>{bubbleText}</output>
      <HeroSprite pose={hero.pose} />
      <span className={css.status}>{hero.active ? t(`state.${hero.pose === 'idle' ? 'idle' : hero.pose}`) : t('state.off')}</span>
      <button type="button" className={css.openPanel} onClick={() => { openSelfEvolution() }}>
        {t('bubble.openPanel')}
      </button>
    </div>
  )
}

/**
 * The hand-drawn sprite: a 12x16 grid of pixel rects — green cap, tan face,
 * green tunic, brown boots — with pose overlays drawn by CSS classes.
 * @param props - the pose the wrapper already derived.
 * @returns the pixel-art hero figure.
 */
function HeroSprite({ pose }: { pose: HeroPose }) {
  return (
    <svg
      className={css.sprite}
      data-sprite-pose={pose}
      viewBox="0 0 12 16"
      width="48"
      height="64"
      role="img"
      aria-hidden="true"
    >
      {/* Cap: brim and cone in adventure green. */}
      <rect x="2" y="1" width="8" height="1" fill="#3e8e4d" />
      <rect x="3" y="0" width="5" height="1" fill="#3e8e4d" />
      {/* Face. */}
      <rect x="3" y="2" width="6" height="3" fill="#e8c39e" />
      {/* Eyes. */}
      <rect x="4" y="3" width="1" height="1" fill="#2b2b2b" />
      <rect x="7" y="3" width="1" height="1" fill="#2b2b2b" />
      {/* Tunic torso with belt. */}
      <rect x="3" y="5" width="6" height="5" fill="#2f7a3d" />
      <rect x="3" y="9" width="6" height="1" fill="#7a5230" />
      {/* Arms. */}
      <rect x="2" y="5" width="1" height="4" fill="#2f7a3d" />
      <rect x="9" y="5" width="1" height="4" fill="#2f7a3d" />
      {/* Legs and boots. */}
      <rect x="3" y="10" width="2" height="4" fill="#5b4632" />
      <rect x="7" y="10" width="2" height="4" fill="#5b4632" />
      <rect x="3" y="14" width="2" height="2" fill="#7a5230" />
      <rect x="7" y="14" width="2" height="2" fill="#7a5230" />
    </svg>
  )
}
