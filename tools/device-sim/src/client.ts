/**
 * The signing HTTP client - the simulator's equivalent of the firmware's modem
 * layer (Appendix E.1).
 *
 * It signs exactly as Appendix E.1.2 specifies:
 *
 *   METHOD \n path \n dev \n ts \n nonce \n sha256hex(body)
 *
 * with `?dev=&ts=&nonce=&sig=` in the query string and no custom headers,
 * because `AT+HTTPPARA="USERDATA"` is not present on every SIM800L firmware.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

export interface DeviceIdentity {
  code: string;
  /** 64 hex characters - the 32-byte secret, decoded before use. */
  secret: string;
}

export const sha256Hex = (value: Buffer | string): string =>
  createHash('sha256').update(value).digest('hex');

export const buildCanonicalString = (input: {
  method: string;
  path: string;
  dev: string;
  ts: number;
  nonce: string;
  body: Buffer;
}): string =>
  [
    input.method.toUpperCase(),
    input.path,
    input.dev,
    String(input.ts),
    input.nonce,
    sha256Hex(input.body),
  ].join('\n');

export const sign = (canonical: string, secretHex: string): string =>
  createHmac('sha256', Buffer.from(secretHex, 'hex')).update(canonical, 'utf8').digest('hex');

export interface DeviceResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  /** The commands piggybacked on every response (§5.3.4). */
  commands: { id: string; type: string; payload: Record<string, unknown> }[];
}

export class DeviceClient {
  /** Offset between the simulator's clock and the server's (§5.3.1). */
  private clockSkewMs = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly identity: DeviceIdentity,
    private readonly verbose = false,
  ) {}

  now(): Date {
    return new Date(Date.now() + this.clockSkewMs);
  }

  /** §5.3.1: the device trusts the server's clock, not its own. */
  async syncClock(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/d/v1/time`);
    if (!response.ok) throw new Error(`GET /d/v1/time failed: ${response.status}`);

    const body = (await response.json()) as { epoch: number };
    this.clockSkewMs = body.epoch * 1000 - Date.now();

    if (this.verbose) {
      console.log(`  clock synced (skew ${Math.round(this.clockSkewMs / 1000)}s)`);
    }
  }

  async request<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    options: { raw?: Buffer; contentType?: string } = {},
  ): Promise<DeviceResponse<T>> {
    const payload =
      options.raw ?? (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8'));

    const ts = Math.floor(this.now().getTime() / 1000);
    const nonce = randomBytes(8).toString('hex');

    const canonical = buildCanonicalString({
      method,
      path,
      dev: this.identity.code,
      ts,
      nonce,
      body: payload,
    });
    const sig = sign(canonical, this.identity.secret);

    const url = `${this.baseUrl}${path}?dev=${this.identity.code}&ts=${ts}&nonce=${nonce}&sig=${sig}`;

    const response = await fetch(url, {
      method,
      headers: {
        'content-type': options.contentType ?? (options.raw ? 'application/octet-stream' : 'application/json'),
      },
      ...(method === 'GET' ? {} : { body: payload }),
    });

    const text = await response.text();
    let parsed: T;
    try {
      parsed = text ? (JSON.parse(text) as T) : ({} as T);
    } catch {
      parsed = { raw: text } as unknown as T;
    }

    if (this.verbose) {
      console.log(`  ${method} ${path} -> ${response.status}`);
    }

    const commands =
      (parsed as { commands?: { id: string; type: string; payload: Record<string, unknown> }[] })
        .commands ?? [];

    return { status: response.status, body: parsed, commands };
  }

  /** §5.3.4: acknowledge a piggybacked command so it stops being resent. */
  async ackCommand(commandId: string, result: 'APPLIED' | 'REJECTED' = 'APPLIED', extra: Record<string, unknown> = {}) {
    return this.request('POST', `/d/v1/commands/${commandId}/ack`, { result, ...extra });
  }
}
