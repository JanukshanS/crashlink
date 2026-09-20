/**
 * Runs a command with the repo-root `.env` applied, if there is one.
 *
 * Why this exists: locally the env lives in `.env` at the repo root
 * (Appendix B), but in the container it arrives as real environment variables
 * from compose `env_file` and there is no `.env` on disk - §5.8.2 step 8 runs
 * `db:seed` and `device:provision` exactly that way. A hard `node --env-file`
 * would crash there, and `--env-file-if-exists` needs Node 22 while the spec
 * targets Node 20. So: load it when present, ignore it when absent.
 *
 * Real environment variables always win, so `DATABASE_URL=... npm run db:seed`
 * still overrides the file.
 *
 *   node scripts/run.mjs tsx prisma/seed.ts
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(HERE, '../../../.env');

/** Minimal dotenv: KEY=VALUE, `export` prefix, #comments, optional quotes. */
const parseEnv = (text) => {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip an unquoted trailing comment, e.g. `KEY=value   # note`.
      value = value.replace(/\s+#.*$/, '').trim();
    }

    out[key] = value;
  }
  return out;
};

if (existsSync(ENV_PATH)) {
  const parsed = parseEnv(readFileSync(ENV_PATH, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    // Never clobber a variable the environment already set.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/run.mjs <command> [args...]');
  process.exit(1);
}

const result = spawnSync(command, args, {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
