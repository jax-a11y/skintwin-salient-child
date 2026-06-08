import { fileURLToPath } from 'url'
import { foregroundChild } from '../../dist/esm/index.js'

const __filename = fileURLToPath(import.meta.url)

/**
 * Simulates a skintwin-ai style AI pipeline worker.
 *
 * Modes (process.argv[2]):
 *   run-short  [ms]     - runs for <ms> milliseconds then exits 0
 *   run-error  [code]   - exits immediately with <code>
 *   run-graceful        - runs until SIGTERM; on signal, prints shutdown
 *                         message and exits 0
 *   run-verbose [count] - prints <count> progress lines then exits 0
 *   run-pipeline        - spawns itself as a foreground child in child mode
 *                         and propagates the child's exit
 *   child               - simple child for pipeline; exits 0 after printing
 */

const mode = process.argv[2]

switch (mode) {
  case 'run-short': {
    const ms = parseInt(process.argv[3] ?? '50', 10)
    process.stdout.write('worker-start\n')
    setTimeout(() => {
      process.stdout.write('worker-done\n')
      process.exit(0)
    }, ms)
    break
  }

  case 'run-error': {
    const code = parseInt(process.argv[3] ?? '1', 10)
    process.stdout.write('worker-error\n')
    process.exit(code)
    break
  }

  case 'run-graceful': {
    process.stdout.write('worker-running\n')
    const t = setInterval(() => {
      process.stdout.write('worker-tick\n')
    }, 50)
    process.on('SIGTERM', () => {
      clearInterval(t)
      process.stdout.write('worker-shutdown\n')
      process.exit(0)
    })
    break
  }

  case 'run-verbose': {
    const count = parseInt(process.argv[3] ?? '5', 10)
    for (let i = 0; i < count; i++) {
      process.stdout.write(`worker-line-${i}\n`)
    }
    process.stdout.write('worker-done\n')
    process.exit(0)
    break
  }

  case 'run-pipeline': {
    // Spawn itself as a foreground child in child mode
    foregroundChild(process.execPath, [__filename, 'child'])
    break
  }

  case 'child': {
    process.stdout.write('pipeline-child-start\n')
    setTimeout(() => {
      process.stdout.write('pipeline-child-done\n')
      process.exit(0)
    }, 20)
    break
  }
}
