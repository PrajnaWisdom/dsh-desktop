// @dsh-desktop/sidecar — probe-index.mjs (diagnostic)
// Boot the sidecar in-process and dump the served index.html to stderr so the
// __DSH_BOOT__ / preload-script structure can be inspected.
import { bootSidecar, log } from './boot.js';

const handle = await bootSidecar();
const { carrier } = handle;
const response = await carrier.dispatch(new Request('http://127.0.0.1/', { headers: { host: '127.0.0.1' } }));
const html = await response.text();
log('INDEX STATUS', response.status, 'bytes', html.length);

// Print the region around __DSH_BOOT__ and the preload script tags.
const idx = html.indexOf('__DSH_BOOT__');
if (idx >= 0) {
  log('__DSH_BOOT__ at', idx, 'context:');
  log(html.slice(Math.max(0, idx - 400), idx + 800));
} else {
  log('NO __DSH_BOOT__ FOUND');
}
log('--- head/script tags ---');
const scripts = [...html.matchAll(/<script[^>]*src="([^"]*)"[^>]*>/g)].map((m) => m[1]);
log('script srcs:', JSON.stringify(scripts));
process.exit(0);
