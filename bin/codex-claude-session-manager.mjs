#!/usr/bin/env node

import { startCleanerServer } from '../src/server.mjs';
import { getDefaultCodexHome } from '../src/core.mjs';
import { getDefaultClaudeHome } from '../src/claude-sessions.mjs';

function printHelp() {
  process.stdout.write([
    'Codex & Claude Code Session Manager',
    '',
    'Usage: codex-claude-session-manager [options]',
    '',
    'Options:',
    '  --port <port>          Listen on a specific local port',
    '  --codex-home <path>    Use a specific .codex directory',
    '  --claude-home <path>   Use a specific .claude directory',
    '  --backup-root <path>   Store backups in a specific directory',
    '  --claude-backup-root <path> Store Claude deletion backups in a specific directory',
    '  --claude-turn-backup-root <path> Store Claude turn deletion backups in a specific directory',
    '  -h, --help             Show this help',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h' || argument === '--help') {
      return { help: true };
    }
    const [flag, inlineValue] = argument.split('=', 2);
    const name = {
      '--port': 'port',
      '--codex-home': 'codexHome',
      '--claude-home': 'claudeHome',
      '--backup-root': 'backupRoot',
      '--claude-backup-root': 'claudeBackupRoot',
      '--claude-turn-backup-root': 'claudeTurnBackupRoot',
    }[flag];
    if (!name) throw new Error(`Unknown option: ${argument}`);
    const value = inlineValue ?? argv[++index];
    if (!value) throw new Error(`Missing value for ${flag}`);
    options[name] = value;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const codexHome = options.codexHome || getDefaultCodexHome();
  const claudeHome = options.claudeHome || getDefaultClaudeHome();
  const { server, url, releaseInstanceLocks } = await startCleanerServer({ ...options, codexHome, claudeHome });
  process.stdout.write(`Codex & Claude Code Session Manager running at ${url}\n`);
  process.stdout.write(`Codex data: ${codexHome}\n`);
  process.stdout.write(`Claude Code data: ${claudeHome}\n`);
  process.stdout.write('Press Ctrl+C to stop.\n');

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(async () => {
      await releaseInstanceLocks();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

try {
  await main();
} catch (error) {
  if (error?.code === 'EACCES') {
    process.stderr.write('The selected port is blocked by Windows. Use --port or CODEX_CLAUDE_SESSION_MANAGER_PORT.\n');
  } else if (error?.code === 'EADDRINUSE') {
    process.stderr.write('The selected port is already in use. The session manager will not switch to another port or start a second instance.\n');
  } else if (error?.code === 'INSTANCE_ALREADY_RUNNING') {
    const location = error.details?.dataPath || 'the selected session data directory';
    const port = error.details?.port;
    process.stderr.write(`Another session-manager instance is already using ${location}.${port ? ` Open http://127.0.0.1:${port}` : ''}\n`);
  } else {
    process.stderr.write(`${error?.message || error}\n`);
  }
  process.exitCode = 1;
}
