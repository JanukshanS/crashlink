/** Process entrypoint (§4.3, §5.8.2 step 7). */
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const main = async (): Promise<void> => {
  const config = loadConfig();
  const app = await buildApp({ config });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // 0.0.0.0 because the process runs in a container behind Nginx (§5.8.2).
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start CrashLink API:', error);
  process.exit(1);
});
