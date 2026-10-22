/**
 * CLI entry for `@truefoundry/trueforge` (`package.json` `bin` → `dist/cli.js`).
 *
 * Kept separate from `main.ts` so Docker / `pnpm start` can boot with env only
 * (`node dist/main.js`), while `npx @truefoundry/trueforge` gets a shebang, `--help`,
 * and `--port`. Flags must be applied before importing `./main` because config
 * reads `process.env` at module load.
 *
 * Topology defaults from env / config (`STANDALONE=true` unless set): standalone
 * uses SQLite with no Redis; `STANDALONE=false` uses Postgres + Redis peering.
 */
import { parseArgs } from 'node:util';

import { PACKAGE_VERSION } from './packageVersion';

function printUsage(): void {
  console.log(`Usage:
  npx @truefoundry/trueforge
  inflex serve --port <n>
  inflex login
  inflex doctor
  inflex run --goal standard|enhanced|advanced --thinking light|balanced|deep|intensive|ultra "task"

Inflex v${PACKAGE_VERSION}. Start the agent server.
Defaults to a local runtime with SQLite and no Redis.
Set STANDALONE=false with Postgres and Redis for multi-replica peering.

Options:
  --port <n>   HTTP port (default: 8790, or PORT env)
  -h, --help   Show this help
`);
}

function applyPort(raw: string | undefined): void {
  if (raw === undefined) {
    return;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port "${raw}" (expected integer 1–65535)`);
  }
  process.env['PORT'] = String(port);
}

try {
  process.env['HOST'] ??= '127.0.0.1';
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  if (portIndex >= 0) {
    applyPort(args[portIndex + 1]);
  }
  if (args[0] && args[0] !== 'serve' && !args[0].startsWith('-')) {
    await (await import('./inflex/cli.js')).inflexCommand(args);
    process.exit(0);
  }
  const { values } = parseArgs({
    args: args[0] === 'serve' ? args.slice(1) : args,
    options: {
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    printUsage();
  } else {
    applyPort(values.port);
    await import('./main.js');
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
