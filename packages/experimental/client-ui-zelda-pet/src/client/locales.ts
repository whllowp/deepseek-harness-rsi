/** `zeldaPet` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'zeldaPet'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'name': '像素勇者',
  'label': '自进化勇者',
  'state.idle': '等待新的会话证据',
  'state.distilling': '守护核正在蒸馏新策略…',
  'state.hurt': '自我修复成功！继续冒险',
  'state.repair': '自我修复成功！继续冒险',
  'state.levelUp': '策略进化！+1 颗心',
  'state.off': '守护核未运行',
  'bubble.evolution': '进化：{rationale}',
  'bubble.repair': '修复：{detail}',
  'bubble.openPanel': '打开自进化面板',
  'bubble.empty': '还没有后台活动；正常使用会话即可',
} as const

/** Key domain of the `zeldaPet` namespace (zh is the source of truth). */
export type ZeldaPetKey = keyof typeof zh

/** English dictionary. */
export const en: Record<ZeldaPetKey, string> = {
  'name': 'Pixel hero',
  'label': 'Self-evolution hero',
  'state.idle': 'Waiting for fresh session evidence',
  'state.distilling': 'The daemon core is distilling a new policy…',
  'state.hurt': 'Self-repair complete! Adventure on',
  'state.repair': 'Self-repair complete! Adventure on',
  'state.levelUp': 'Policy evolved! +1 heart',
  'state.off': 'Daemon core not running',
  'bubble.evolution': 'Evolution: {rationale}',
  'bubble.repair': 'Repair: {detail}',
  'bubble.openPanel': 'Open the Self-evolution panel',
  'bubble.empty': 'No background activity yet; work in a session normally',
}
