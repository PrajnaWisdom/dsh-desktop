// @dsh-desktop/sidecar — test-bundled-flow.mjs
// Bundled-flow check: boot with a FRESH home and an EXTERNAL anchor (simulating
// the CI-installed resource), then assert that boot.js linked the home's
// @deepseek-ai scope junction and the composition came up.
//
//   node test-bundled-flow.mjs --home <fresh-home> --anchor <external dsh package.json>

import { lstatSync, readlinkSync } from 'node:fs';
import { bootSidecar, log, DSH_HOME, INSTALL_ANCHOR } from './boot.js';

log('home:', DSH_HOME);
log('anchor:', INSTALL_ANCHOR);

const handle = await bootSidecar();

const scopeLink = `${DSH_HOME}/profiles/node_modules/@deepseek-ai`;
let junction;
try {
  const st = lstatSync(scopeLink);
  junction = { isSymlink: st.isSymbolicLink(), target: readlinkSync(scopeLink) };
} catch (error) {
  junction = { error: String(error?.message ?? error) };
}
log('JUNCTION', JSON.stringify(junction));
log('BOOT_OK', JSON.stringify({ dsh: handle.dshVersion, profile: handle.profile.name, bootMs: handle.bootMs }));
process.exit(0);
