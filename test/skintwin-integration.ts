/**
 * Exhaustive end-to-end integration tests validating foreground-child
 * behaviour across scenarios inspired by the skintwin-ai ecosystem:
 *   - AI pipeline workers (short-lived, long-running, error paths)
 *   - Graceful shutdown with SIGTERM
 *   - Multi-stage pipelines via nested foregroundChild
 *   - Verbose / high-throughput stdout passthrough
 *   - Async cleanup handlers
 *   - Concurrent sequential worker runs
 *   - Cleanup-driven exit code override
 */

import { spawn } from 'child_process'
import t from 'tap'
import { fileURLToPath } from 'url'

const fixture = fileURLToPath(
  new URL('./fixtures/skintwin-worker.js', import.meta.url),
)

const run = (
  args: string[],
  options?: Parameters<typeof spawn>[2],
): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> =>
  new Promise(resolve => {
    const child = spawn(process.execPath, [fixture, ...args], {
      stdio: ['ignore', 'pipe', 'inherit'],
      ...options,
    })
    const chunks: Buffer[] = []
    child.stdout?.on('data', (c: Buffer) => chunks.push(c))
    child.on('close', (code, signal) => {
      resolve({
        code,
        signal: signal as NodeJS.Signals | null,
        out: Buffer.concat(chunks).toString(),
      })
    })
  })

const isWin = process.platform === 'win32'

// ------------------------------------------------------------
// 1. Short-lived worker – clean exit
// ------------------------------------------------------------
t.test('run-short exits 0 and emits start/done markers', async t => {
  const { code, signal, out } = await run(['run-short', '30'])
  t.equal(code, 0, 'exit code 0')
  t.equal(signal, null, 'no signal')
  t.ok(out.includes('worker-start'), 'printed worker-start')
  t.ok(out.includes('worker-done'), 'printed worker-done')
})

// ------------------------------------------------------------
// 2. Short-lived worker with zero delay
// ------------------------------------------------------------
t.test('run-short with 0 ms delay exits immediately', async t => {
  const { code, signal, out } = await run(['run-short', '0'])
  t.equal(code, 0)
  t.equal(signal, null)
  t.ok(out.includes('worker-done'))
})

// ------------------------------------------------------------
// 3. Error exit code propagation
// ------------------------------------------------------------
t.test('run-error propagates exit code 1', async t => {
  const { code, signal, out } = await run(['run-error', '1'])
  t.equal(code, 1, 'exit code 1')
  t.equal(signal, null)
  t.ok(out.includes('worker-error'))
})

t.test('run-error propagates exit code 42', async t => {
  const { code } = await run(['run-error', '42'])
  t.equal(code, 42)
})

t.test('run-error propagates exit code 0', async t => {
  const { code } = await run(['run-error', '0'])
  t.equal(code, 0)
})

// ------------------------------------------------------------
// 4. Graceful SIGTERM shutdown (Unix only)
// ------------------------------------------------------------
t.test(
  'run-graceful shuts down cleanly on SIGTERM',
  { skip: isWin ? 'SIGTERM behaviour differs on Windows' : false },
  async t => {
    const child = spawn(process.execPath, [fixture, 'run-graceful'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))

    // Wait for 'worker-running' before sending SIGTERM
    await new Promise<void>(resolve => {
      const onData = () => {
        const out = Buffer.concat(chunks).toString()
        if (out.includes('worker-running')) {
          child.stdout.off('data', onData)
          resolve()
        }
      }
      child.stdout.on('data', onData)
    })

    child.kill('SIGTERM')

    const { code, signal } = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>(resolve =>
      child.on('close', (code, signal) =>
        resolve({ code, signal: signal as NodeJS.Signals | null }),
      ),
    )
    const out = Buffer.concat(chunks).toString()

    t.ok(out.includes('worker-running'), 'worker started')
    t.ok(out.includes('worker-shutdown'), 'worker shut down gracefully')
    // After graceful SIGTERM, parent exits 0 or with SIGTERM
    t.ok(code === 0 || signal === 'SIGTERM', 'clean exit')
  },
)

// ------------------------------------------------------------
// 5. Verbose / high-throughput stdout passthrough
// ------------------------------------------------------------
t.test('run-verbose passes through all output lines', async t => {
  const count = 20
  const { code, out } = await run(['run-verbose', String(count)])
  t.equal(code, 0)
  for (let i = 0; i < count; i++) {
    t.ok(out.includes(`worker-line-${i}`), `line ${i} present`)
  }
  t.ok(out.includes('worker-done'))
})

// Large output stress test
t.test('run-verbose with 200 lines completes without data loss', async t => {
  const count = 200
  const { code, out } = await run(['run-verbose', String(count)])
  t.equal(code, 0)
  const lines = out.split('\n').filter(l => l.startsWith('worker-line-'))
  t.equal(lines.length, count, `all ${count} lines received`)
})

// ------------------------------------------------------------
// 6. Pipeline: foregroundChild spawning foregroundChild
// ------------------------------------------------------------
t.test('run-pipeline propagates nested foreground child exit', async t => {
  const { code, signal, out } = await run(['run-pipeline'])
  t.equal(code, 0, 'pipeline exits 0')
  t.equal(signal, null)
  t.ok(out.includes('pipeline-child-start'), 'pipeline child started')
  t.ok(out.includes('pipeline-child-done'), 'pipeline child completed')
})

// ------------------------------------------------------------
// 7. Concurrent sequential worker runs (simulate AI batch)
// ------------------------------------------------------------
t.test('sequential workers all succeed', async t => {
  const results = []
  for (let i = 0; i < 5; i++) {
    results.push(await run(['run-short', '10']))
  }
  for (const { code } of results) {
    t.equal(code, 0)
  }
})

// ------------------------------------------------------------
// 8. Cleanup handler overrides exit code (via change-exit fixture)
// ------------------------------------------------------------
t.test(
  'cleanup can override child exit code to 0',
  { skip: isWin ? 'exit code override unreliable on Windows' : false },
  t => {
    t.plan(2)
    const changeFixture = fileURLToPath(
      new URL('./fixtures/change-exit.js', import.meta.url),
    )
    // child exits 3, cleanup changes parent exit to 0
    const child = spawn(
      process.execPath,
      [changeFixture, 'parent', '3', '0', '0'],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    child.on('close', (code, signal) => {
      t.equal(signal, null)
      t.equal(code, 0, 'cleanup overrode exit code to 0')
    })
  },
)

// ------------------------------------------------------------
// 9. Async cleanup with deferred result
// ------------------------------------------------------------
t.test(
  'async cleanup with deferred exit code override',
  { skip: isWin ? 'exit code override unreliable on Windows' : false },
  t => {
    t.plan(2)
    const changeFixture = fileURLToPath(
      new URL('./fixtures/change-exit.js', import.meta.url),
    )
    // child exits 3, async cleanup (defer=1) changes parent exit to 1
    const child = spawn(
      process.execPath,
      [changeFixture, 'parent', '3', '1', '1'],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    child.on('close', (code, signal) => {
      t.equal(signal, null)
      t.equal(code, 1, 'async cleanup overrode exit code to 1')
    })
  },
)

// ------------------------------------------------------------
// 10. Worker start marker ordering guarantee
// ------------------------------------------------------------
t.test(
  'worker-start always appears before worker-done in output',
  async t => {
    const { out } = await run(['run-short', '10'])
    const startIdx = out.indexOf('worker-start')
    const doneIdx = out.indexOf('worker-done')
    t.ok(startIdx >= 0, 'has worker-start')
    t.ok(doneIdx >= 0, 'has worker-done')
    t.ok(startIdx < doneIdx, 'start before done')
  },
)

// ------------------------------------------------------------
// 11. Multiple concurrent e2e runs (parallel)
// ------------------------------------------------------------
t.test('parallel short worker runs all exit 0', async t => {
  const runs = Array.from({ length: 6 }, () => run(['run-short', '20']))
  const results = await Promise.all(runs)
  for (const { code } of results) {
    t.equal(code, 0)
  }
})
