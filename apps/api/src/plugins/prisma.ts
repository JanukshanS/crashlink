/** Prisma 6 client as a Fastify decorator (§4.3). */
import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export interface PrismaPluginOptions {
  /** Tests inject a shared client so fixtures and the app see one connection pool. */
  client?: PrismaClient;
}

export default fp<PrismaPluginOptions>(
  async (app: FastifyInstance, options: PrismaPluginOptions) => {
    const injected = Boolean(options.client);
    const prisma = options.client ?? new PrismaClient();

    if (!injected) await prisma.$connect();
    app.decorate('prisma', prisma);

    // Only disconnect a client we own; an injected one outlives the app instance.
    app.addHook('onClose', async () => {
      if (!injected) await prisma.$disconnect();
    });
  },
  { name: 'prisma' },
);
