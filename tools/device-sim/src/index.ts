/**
 * HMAC-signing device simulator (Appendix C, CLAUDE.md commands).
 *
 * The scenarios (`collision-timeout`, etc.) drive the `/d/v1` gateway, which is
 * not built yet, so only the `vector` command is implemented: it prints the
 * Appendix E.1.2 canonical string and signature for a request, which is what
 * the firmware must be checked against *before* anyone touches the modem.
 *
 *   npm run sim -w tools/device-sim -- vector --secret <64 hex>
 */
import { createHash, createHmac } from 'node:crypto';

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/** METHOD \n path \n dev \n ts \n nonce \n sha256hex(body) - path excludes the query. */
const buildCanonicalString = (input: {
  method: string;
  path: string;
  dev: string;
  ts: number;
  nonce: string;
  body: string;
}): string =>
  [input.method.toUpperCase(), input.path, input.dev, String(input.ts), input.nonce, sha256Hex(input.body)].join(
    '\n',
  );

const flag = (argv: string[], name: string, fallback?: string): string => {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined || value.startsWith('--')) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  }
  return value;
};

const main = (): void => {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command !== 'vector') {
    // eslint-disable-next-line no-console
    console.error(
      `Unknown or unimplemented command: ${command ?? '(none)'}\n\n` +
        'Available now:\n' +
        '  vector --secret <hex> [--method POST] [--path /d/v1/heartbeat]\n' +
        '         [--dev CL-0001] [--ts <unix>] [--nonce <hex>] [--body <json>]\n\n' +
        'The scenario commands (collision-timeout, ...) land with the /d/v1\n' +
        'device gateway - see CLAUDE.md and spec §5.3.',
    );
    process.exitCode = 1;
    return;
  }

  const secret = flag(argv, 'secret');
  const request = {
    method: flag(argv, 'method', 'POST'),
    path: flag(argv, 'path', '/d/v1/heartbeat'),
    dev: flag(argv, 'dev', 'CL-0001'),
    ts: Number(flag(argv, 'ts', String(Math.floor(Date.now() / 1000)))),
    nonce: flag(argv, 'nonce', 'a91f3c'),
    body: flag(argv, 'body', ''),
  };

  const canonical = buildCanonicalString(request);
  const sig = createHmac('sha256', Buffer.from(secret, 'hex')).update(canonical, 'utf8').digest('hex');

  /* eslint-disable no-console */
  console.log('canonical string (\\n separated):');
  console.log(JSON.stringify(canonical));
  console.log('');
  console.log('signature:', sig);
  console.log('');
  console.log(
    `query: ?dev=${request.dev}&ts=${request.ts}&nonce=${request.nonce}&sig=${sig}`,
  );
  /* eslint-enable no-console */
};

main();
