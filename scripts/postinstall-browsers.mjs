// Installs the Chromium build Playwright expects, for local development only.
//
// CI sets PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 on every `pnpm install` and the
// e2e job installs browsers explicitly (with OS deps), so this script must be a
// no-op there. The Playwright CLI ignores that variable itself, which is why
// the gate lives here and not in package.json.
import { spawnSync } from 'node:child_process';

const skip =
  process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1' ||
  process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === 'true' ||
  process.env.CI === 'true' ||
  process.env.CI === '1';

if (skip) {
  console.log('postinstall: skipping Playwright browser download (CI or PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD set)');
  process.exit(0);
}

const result = spawnSync('pnpm', ['exec', 'playwright', 'install', 'chromium'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
