/**
 * Server entrypoint. Boots the app and wires graceful shutdown.
 *
 * `.env` is loaded here and nowhere else: tests construct the app directly with
 * explicit config, so they are never at the mercy of a developer's local file.
 *
 * Note on `PORT`: it follows the deployment convention, but the `dev` script
 * pins it to 3001 with `cross-env`. Without that, an ambient `PORT` inherited
 * from a parent process (a task runner, an IDE, a preview harness) silently
 * moves the API onto the web app's port and the feed just never connects.
 */

import 'dotenv/config';
import { createApp } from './app.ts';

const { app, config, close } = createApp();

const server = app.listen(config.port, () => {
  console.log(
    `[feed] listening on http://localhost:${config.port} (model mode: ${config.modelMode})`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[feed] ${signal} received, shutting down`);
    // Close the SSE hubs first: open streams would otherwise hold the server
    // open indefinitely, and `server.close` waits for in-flight responses.
    void close().finally(() => server.close(() => process.exit(0)));
  });
}
