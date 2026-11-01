/** `rsi.panel` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'rsi.panel'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel': '自进化',
  'title': '自进化活动',
  'daemon.on': '守护核按计划在后台运行',
  'daemon.off': '守护核已停用（daemonEnabled: false）',
  'policy.auto': '达标即在后台自动合入',
  'policy.consult': '达标后等你合入',
  'section.evolutions': '进化',
  'section.repairs': '修复',
  'empty': '守护核还没有后台活动。正常使用会话即可，有新证据时它会自动进化与修复。',
  'loading': '正在读取自进化活动…',
  'error': '读取自进化活动失败：{message}',
  'retry': '重试',
  'evolution.improvement': '基准提升 {value}',
  'evolution.guidance': '指引（{count} 条）',
  'evolution.skills': '技能（{count} 个）',
  'evolution.trigger.command': '手动循环',
  'evolution.trigger.tool': '工具循环',
  'evolution.trigger.schedule': '计划循环',
  'repair.kind.cycle-timeout': '超时',
  'repair.kind.cycle-error': '错误',
  'repair.recovery.retried': '退避 {ms} 毫秒后重试',
  'repair.recovery.deferred': '顺延 {ms} 毫秒到下一间隔',
  'repair.attempt': '第 {n} 次尝试',
} as const

/** Key domain of the `rsi.panel` namespace (zh is the source of truth). */
export type RsiPanelKey = keyof typeof zh

/** English dictionary. */
export const en: Record<RsiPanelKey, string> = {
  'panel': 'Self-evolution',
  'title': 'Self-evolution activity',
  'daemon.on': 'Daemon core cycles in the background on schedule',
  'daemon.off': 'Daemon core disabled (daemonEnabled: false)',
  'policy.auto': 'Qualifying candidates merge in the background',
  'policy.consult': 'Qualifying candidates wait for your merge',
  'section.evolutions': 'Evolutions',
  'section.repairs': 'Repairs',
  'empty': 'No background activity yet. Work in a session normally; the daemon evolves and repairs itself once fresh evidence waits.',
  'loading': 'Loading self-evolution activity…',
  'error': 'Reading self-evolution activity failed: {message}',
  'retry': 'Retry',
  'evolution.improvement': 'benchmark improvement {value}',
  'evolution.guidance': 'Guidance ({count} lines)',
  'evolution.skills': 'Skills ({count})',
  'evolution.trigger.command': 'manual cycle',
  'evolution.trigger.tool': 'tool cycle',
  'evolution.trigger.schedule': 'scheduled cycle',
  'repair.kind.cycle-timeout': 'timed out',
  'repair.kind.cycle-error': 'error',
  'repair.recovery.retried': 'retried after {ms} ms',
  'repair.recovery.deferred': 'deferred {ms} ms to the next interval',
  'repair.attempt': 'attempt {n}',
}
