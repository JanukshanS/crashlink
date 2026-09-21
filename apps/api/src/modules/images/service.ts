/**
 * §4.4.3 / FR-IMG-01 - resumable chunked image upload with SHA-256 verification.
 *
 * Chunks land in `<IMAGE_DIR>/tmp/<sessionId>.part` and are only promoted to
 * `<IMAGE_DIR>/yyyy/mm/<incidentId>.jpg` after the byte count *and* the hash
 * match what the device declared. A photo the server cannot verify is marked
 * FAILED rather than shown, because an unverified crash photo is evidence of
 * nothing (NFR-04).
 *
 * Offsets are strictly sequential: `nextOffset` is the server's count of bytes
 * actually on disk, which is what makes a retry after a device reboot resume
 * correctly (§4.4.3).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, appendFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { IMAGE_CHUNK_MAX_BYTES } from '@crashlink/contracts';
import { AppError } from '../../lib/errors.js';
import type { Clock } from '../../lib/time.js';

export interface ImageServiceDeps {
  prisma: PrismaClient;
  clock: Clock;
  imageDir: string;
  maxBytes: number;
  chunkMaxBytes: number;
  fileUrlSecret: string;
  signedUrlTtlSec: number;
}

export interface OpenSessionResult {
  sessionId: string;
  nextOffset: number;
  chunkSize: number;
  state: string;
}

export class ImageService {
  constructor(private readonly deps: ImageServiceDeps) {}

  private tmpPath(sessionId: string): string {
    return resolve(this.deps.imageDir, 'tmp', `${sessionId}.part`);
  }

  /** §5.6.6 layout: `/data/images/yyyy/mm/<incidentId>.jpg`. */
  private storageKey(incidentId: string, at: Date): string {
    const yyyy = String(at.getUTCFullYear());
    const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
    return `${yyyy}/${mm}/${incidentId}.jpg`;
  }

  finalPath(storageKey: string): string {
    return resolve(this.deps.imageDir, storageKey);
  }

  /**
   * Opens (or resumes) the upload session for an incident. One image per
   * incident (`@@unique` on incidentId), so a device retrying after a reboot
   * gets the same session and the offset it actually reached.
   */
  async openSession(input: {
    incidentId: string;
    bytes: number;
    sha256: string;
    chunkSize: number;
    mime: string;
  }): Promise<OpenSessionResult> {
    const { prisma, clock } = this.deps;

    if (input.bytes > this.deps.maxBytes) {
      throw new AppError('PAYLOAD_TOO_LARGE', `Image exceeds the ${this.deps.maxBytes} byte limit.`);
    }
    if (input.chunkSize > Math.min(this.deps.chunkMaxBytes, IMAGE_CHUNK_MAX_BYTES)) {
      throw new AppError('VALIDATION_FAILED', 'Chunk size is larger than the server allows.');
    }

    const existing = await prisma.incidentImage.findUnique({ where: { incidentId: input.incidentId } });

    if (existing) {
      // A re-declared image with different content restarts the upload; the
      // device only does this when its local file changed.
      if (existing.sha256Expected === input.sha256 && existing.state !== 'COMPLETE') {
        return {
          sessionId: existing.id,
          nextOffset: existing.receivedBytes,
          chunkSize: existing.chunkSize,
          state: existing.state,
        };
      }
      if (existing.state === 'COMPLETE') {
        return {
          sessionId: existing.id,
          nextOffset: existing.receivedBytes,
          chunkSize: existing.chunkSize,
          state: existing.state,
        };
      }

      await unlink(this.tmpPath(existing.id)).catch(() => undefined);
      await prisma.incidentImage.delete({ where: { id: existing.id } });
    }

    const session = await prisma.incidentImage.create({
      data: {
        incidentId: input.incidentId,
        state: 'RESERVED',
        expectedBytes: input.bytes,
        receivedBytes: 0,
        chunkSize: input.chunkSize,
        sha256Expected: input.sha256,
        mime: input.mime,
      },
    });

    await mkdir(dirname(this.tmpPath(session.id)), { recursive: true });
    await writeFile(this.tmpPath(session.id), Buffer.alloc(0));

    await prisma.incident.update({
      where: { id: input.incidentId },
      data: { photoStatus: 'PENDING' },
    });

    void clock;
    return { sessionId: session.id, nextOffset: 0, chunkSize: session.chunkSize, state: session.state };
  }

  /**
   * Appends one chunk. The offset must equal what the server already holds:
   * accepting an out-of-order chunk would silently corrupt the file and the
   * hash check at the end would blame the camera.
   */
  async appendChunk(input: {
    sessionId: string;
    offset: number;
    chunk: Buffer;
  }): Promise<{ nextOffset: number; received: number; expected: number; state: string }> {
    const { prisma } = this.deps;

    const session = await prisma.incidentImage.findUnique({ where: { id: input.sessionId } });
    if (!session) throw new AppError('NOT_FOUND', 'Upload session not found.');
    if (session.state === 'COMPLETE') {
      return {
        nextOffset: session.receivedBytes,
        received: session.receivedBytes,
        expected: session.expectedBytes,
        state: session.state,
      };
    }
    if (session.state === 'FAILED') {
      throw new AppError('CONFLICT', 'This upload session has already failed.');
    }

    if (input.chunk.length === 0) {
      throw new AppError('VALIDATION_FAILED', 'Chunk is empty.');
    }
    if (input.chunk.length > session.chunkSize) {
      throw new AppError('PAYLOAD_TOO_LARGE', 'Chunk is larger than the session chunk size.');
    }

    // A repeat of the previous chunk (the device did not get our reply) is not
    // an error - answer with the offset it should use next.
    if (input.offset < session.receivedBytes) {
      return {
        nextOffset: session.receivedBytes,
        received: session.receivedBytes,
        expected: session.expectedBytes,
        state: session.state,
      };
    }
    if (input.offset !== session.receivedBytes) {
      throw new AppError('CONFLICT', `Expected offset ${session.receivedBytes}, got ${input.offset}.`, {
        nextOffset: session.receivedBytes,
      });
    }
    if (session.receivedBytes + input.chunk.length > session.expectedBytes) {
      throw new AppError('PAYLOAD_TOO_LARGE', 'Chunk would exceed the declared image size.');
    }

    await appendFile(this.tmpPath(session.id), input.chunk);

    const received = session.receivedBytes + input.chunk.length;
    const updated = await prisma.incidentImage.update({
      where: { id: session.id },
      data: { state: 'UPLOADING', receivedBytes: received },
    });

    await prisma.incident.update({
      where: { id: session.incidentId },
      data: { photoStatus: 'UPLOADING' },
    });

    return {
      nextOffset: updated.receivedBytes,
      received: updated.receivedBytes,
      expected: updated.expectedBytes,
      state: updated.state,
    };
  }

  /**
   * Verifies size and SHA-256, then promotes the file. A mismatch marks the
   * image FAILED and leaves the incident's photo status FAILED - the owner is
   * told the photo could not be verified rather than shown a broken one.
   */
  async complete(sessionId: string): Promise<{
    state: string;
    sha256: string | null;
    bytes: number;
    reason: string | null;
    incidentId: string;
  }> {
    const { prisma, clock } = this.deps;

    const session = await prisma.incidentImage.findUnique({ where: { id: sessionId } });
    if (!session) throw new AppError('NOT_FOUND', 'Upload session not found.');

    if (session.state === 'COMPLETE') {
      return {
        state: session.state,
        sha256: session.sha256Actual,
        bytes: session.receivedBytes,
        reason: null,
        incidentId: session.incidentId,
      };
    }

    const tmp = this.tmpPath(session.id);
    const fail = async (reason: string) => {
      await prisma.incidentImage.update({
        where: { id: session.id },
        data: { state: 'FAILED', failureReason: reason },
      });
      await prisma.incident.update({
        where: { id: session.incidentId },
        data: { photoStatus: 'FAILED' },
      });
      await unlink(tmp).catch(() => undefined);
      return {
        state: 'FAILED',
        sha256: null,
        bytes: session.receivedBytes,
        reason,
        incidentId: session.incidentId,
      };
    };

    if (!existsSync(tmp)) return fail('UPLOAD_MISSING');

    const size = (await stat(tmp)).size;
    if (size !== session.expectedBytes) {
      return fail(`SIZE_MISMATCH expected ${session.expectedBytes} got ${size}`);
    }

    const actual = createHash('sha256').update(await readFile(tmp)).digest('hex');
    if (actual !== session.sha256Expected) return fail('SHA256_MISMATCH');

    const storageKey = this.storageKey(session.incidentId, clock.now());
    const destination = this.finalPath(storageKey);
    await mkdir(dirname(destination), { recursive: true });
    await rename(tmp, destination);

    await prisma.incidentImage.update({
      where: { id: session.id },
      data: {
        state: 'COMPLETE',
        sha256Actual: actual,
        storageKey,
        completedAt: clock.now(),
        failureReason: null,
      },
    });

    await prisma.incident.update({
      where: { id: session.incidentId },
      data: { photoStatus: 'AVAILABLE' },
    });

    return {
      state: 'COMPLETE',
      sha256: actual,
      bytes: size,
      reason: null,
      incidentId: session.incidentId,
    };
  }

  /**
   * §5.7.1: `sig = HMAC(FILE_URL_SECRET, key + exp)`, `exp` <= 5 min.
   *
   * A real HMAC, not `sha256(secret + message)`: the plain keyed hash is open
   * to length extension, which would let a holder of one valid link forge a
   * signature for a longer key.
   */
  private hmac(storageKey: string, exp: number): string {
    return createHmac('sha256', this.deps.fileUrlSecret).update(`${storageKey}${exp}`).digest('hex');
  }

  signUrl(storageKey: string, now: Date): { url: string; expiresAt: Date; sig: string; exp: number } {
    const expiresAt = new Date(now.getTime() + this.deps.signedUrlTtlSec * 1000);
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const sig = this.hmac(storageKey, exp);
    return {
      url: `/api/v1/files/images/${storageKey}?exp=${exp}&sig=${sig}`,
      expiresAt,
      sig,
      exp,
    };
  }

  verifyUrlSignature(storageKey: string, exp: number, sig: string, now: Date): boolean {
    if (!Number.isInteger(exp)) return false;
    if (exp * 1000 < now.getTime()) return false;
    // An `exp` further out than the TTL was not issued by us.
    if (exp * 1000 > now.getTime() + this.deps.signedUrlTtlSec * 1000 + 1000) return false;
    if (!/^[0-9a-f]{64}$/.test(sig)) return false;

    // Constant-time: the comparison must not leak how many characters matched.
    return timingSafeEqual(Buffer.from(this.hmac(storageKey, exp), 'hex'), Buffer.from(sig, 'hex'));
  }

  /** Guards against a crafted key escaping IMAGE_DIR. */
  resolveWithinImageDir(storageKey: string): string | null {
    const root = resolve(this.deps.imageDir);
    const target = resolve(join(root, storageKey));
    return target.startsWith(root) ? target : null;
  }
}
