/**
 * Local git ledger for merged RSI policy generations: every merge and every
 * rollback materializes the adopted artifact set as plain files inside a
 * dedicated git repository and commits it, so `git log` names each change
 * point and `git show` diffs any two adopted policies.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi/ledger
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { RsiCycleId } from './branding.ts'
import type { RsiGeneration } from './types.ts'

/** Milliseconds one ledger git command gets before termination; the ledger repo is tiny, so this is a fixed lifecycle constant. */
const GIT_TIMEOUT_MS = 10_000
/** In-memory stdout cap per ledger git command. */
const GIT_OUTPUT_MAX_BYTES = 64 * 1024
/** Retained stderr tail for diagnostics. */
const GIT_STDERR_TAIL_BYTES = 16 * 1024
/** Milliseconds a git child gets to exit after termination starts. */
const GIT_GRACE_MS = 2_000
/** Ledger identity; the scrubbed environment carries no user git config. */
const LEDGER_AUTHOR = { name: 'dual-core-rsi', email: 'rsi@dsh.invalid' }

/** Why one generation entered the ledger. */
export type RsiLedgerReason = 'merge' | 'rollback'

/** One ledger record request handed to {@link RsiLedger.record}. */
export interface RsiLedgerEntry {
  /** Why the generation became the active policy. */
  readonly reason: RsiLedgerReason
  /** Generation entering the ledger. */
  readonly generation: RsiGeneration
  /** Cycle record that produced the generation, when one exists. */
  readonly cycleId?: RsiCycleId | undefined
  /** Benchmark score of the generation's own evidence, when it carries any. */
  readonly score?: number | undefined
  /** One-line human-facing summary line for the commit message. */
  readonly summary: string
}

/**
 * Settled outcome of one ledger record attempt: exactly one of
 * {@link revision} or {@link error} is present, keyed by {@link committed}.
 */
export interface RsiLedgerOutcome {
  /** Whether the adopted generation landed as a ledger commit. */
  readonly committed: boolean
  /** Committed revision; absent when the ledger did not record. */
  readonly revision?: string | undefined
  /** Failure report; absent when the ledger recorded the commit. */
  readonly error?: string | undefined
}

/** Settled git command facts; a nonzero exit is a result, not an exception. */
interface GitRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

/**
 * Record adopted RSI policy generations in a dedicated local git repository.
 * The repository never touches the user's working tree; a missing or failing
 * git executable surfaces as `{ committed: false }` so callers can report the
 * audit-trail gap without undoing the durable swap that already settled.
 */
export class RsiLedger {
  private executable: Promise<string | null> | undefined

  /**
   * @param ctx - context with `ctx.subprocess` injected.
   * @param directory - absolute ledger repository directory.
   */
  constructor(
    private readonly ctx: Context,
    private readonly directory: string,
  ) {}

  /** Resolve the git executable once per ledger lifetime. */
  private git(): Promise<string | null> {
    this.executable ??= this.ctx.subprocess.resolveExecutable('git', undefined, new AbortController().signal)
      .then(executable => executable, () => null)
    return this.executable
  }

  /**
   * Run `git <args>` inside the ledger directory.
   * @param executable - resolved git executable.
   * @param args - git arguments; never shell-interpreted.
   * @param signal - cancellation.
   * @returns exit facts and collected output.
   * @throws when the command times out, is aborted, or cannot spawn.
   */
  private async run(executable: string, args: readonly string[], signal: AbortSignal): Promise<GitRunResult> {
    const timeout = AbortSignal.timeout(GIT_TIMEOUT_MS)
    const combined = AbortSignal.any([signal, timeout])
    // One scrubbed command environment shared by every ledger git child.
    const env = {
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
      GIT_AUTHOR_NAME: LEDGER_AUTHOR.name,
      GIT_AUTHOR_EMAIL: LEDGER_AUTHOR.email,
      GIT_COMMITTER_NAME: LEDGER_AUTHOR.name,
      GIT_COMMITTER_EMAIL: LEDGER_AUTHOR.email,
    } as const
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, ...args],
      cwd: this.directory,
      env,
      signal: combined,
      graceMs: GIT_GRACE_MS,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: GIT_OUTPUT_MAX_BYTES },
        stderr: { maxBytes: GIT_STDERR_TAIL_BYTES },
      },
    })
    const outcome = await handle.done
    /* v8 ignore start -- the fixed timeout far exceeds every ledger command; a real abort only occurs on host teardown */
    if (combined.aborted) {
      throw new Error(`git ${args.join(' ')} ${timeout.aborted ? `timed out after ${GIT_TIMEOUT_MS}ms` : 'was aborted'}`)
    }
    /* v8 ignore stop */
    /* v8 ignore start -- collect-mode stdio always yields both readers. */
    const readers = handle.collected
    const stdout = readers.stdout?.readFrom(0).text ?? ''
    const stderr = readers.stderr?.readFrom(0).text ?? ''
    /* v8 ignore stop */
    return { exitCode: outcome.exitCode, stdout, stderr }
  }

  /** Reject a failed command with its stderr. */
  private async ok(executable: string, args: readonly string[], signal: AbortSignal, what: string): Promise<GitRunResult> {
    const result = await this.run(executable, args, signal)
    if (result.exitCode !== 0) {
      throw new Error(`${what} failed: ${result.stderr.trim()}`)
    }
    return result
  }

  /**
   * Write one generation's artifact set as ledger files.
   * @param entry - the generation and its provenance.
   */
  private async materialize(entry: RsiLedgerEntry): Promise<void> {
    const policyDir = join(this.directory, 'policy')
    // Replace the whole policy tree so skills dropped by the new set leave no stale files.
    await rm(policyDir, { recursive: true, force: true })
    const skillsDir = join(policyDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    const guidance = [
      '# Distilled guidance',
      '',
      ...entry.generation.artifacts.guidance.map(line => `- ${line}`),
    ].join('\n')
    await writeFile(join(policyDir, 'guidance.md'), `${guidance}\n`)
    for (const skill of entry.generation.artifacts.skills) {
      await writeFile(join(skillsDir, `${skill.name}.md`), [
        '---',
        `description: ${JSON.stringify(skill.description)}`,
        '---',
        '',
        skill.content,
        '',
      ].join('\n'))
    }
    await writeFile(join(policyDir, 'meta.json'), `${JSON.stringify({
      generationId: entry.generation.id,
      origin: entry.generation.origin,
      parent: entry.generation.parent,
      benchmark: entry.generation.benchmark === undefined
        ? null
        : { provider: entry.generation.benchmark.provider, score: entry.generation.benchmark.score },
      reason: entry.reason,
      ...entry.cycleId === undefined ? {} : { cycleId: entry.cycleId },
      // The commit itself carries the timestamp; the tree stays byte-identical for identical generations.
    }, null, 2)}\n`)
  }

  /**
   * Record one adopted generation as a ledger commit.
   * @param entry - the generation entering the ledger.
   * @param signal - cancellation.
   * @returns the committed revision, or the failure that kept the ledger unchanged.
   */
  async record(entry: RsiLedgerEntry, signal: AbortSignal): Promise<RsiLedgerOutcome> {
    try {
      const executable = await this.git()
      if (executable === null) {
        return { committed: false, error: 'the git executable is not available on this host' }
      }
      await mkdir(this.directory, { recursive: true })
      const inside = await this.run(executable, ['rev-parse', '--is-inside-work-tree'], signal)
      if (inside.exitCode !== 0) {
        await this.ok(executable, ['init', '--quiet', '.'], signal, 'git init')
        await writeFile(join(this.directory, 'README.md'), [
          '# Dual-core RSI policy ledger',
          '',
          'One commit per adopted policy generation: merges and rollbacks of the',
          'distilled working policy. `git log` names every change point; `git show`',
          'diffs any two adopted policies. This repository belongs to the RSI daemon',
          'and is separate from any project working tree.',
          '',
        ].join('\n'))
      }
      await this.materialize(entry)
      await this.ok(executable, ['add', '--all'], signal, 'git add')
      const message = [
        `rsi ${entry.reason}: ${entry.generation.id}`,
        entry.score === undefined ? '' : `score ${entry.score.toFixed(3)}`,
        entry.summary,
      ].filter(part => part !== '').join(' | ')
      await this.ok(executable, ['commit', '--quiet', '--message', message], signal, 'git commit')
      const revision = (await this.ok(executable, ['rev-parse', 'HEAD'], signal, 'git rev-parse')).stdout.trim()
      return { committed: true, revision }
    } catch (error) {
      /* v8 ignore next -- the String arm needs a non-Error rejection, which spawn never produces */
      const detail = error instanceof Error ? error.message : String(error)
      return { committed: false, error: detail }
    }
  }
}
