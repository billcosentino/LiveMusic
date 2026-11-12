// Runs src/scrape.js until it finishes cleanly. Node on Windows occasionally aborts inside libuv while many
// downloads are in flight (an assertion in async.c); scrape.js saves progress as it goes and skips venues
// already checked in the last 12 hours, so each restart resumes where the last one stopped.
//   node src/run-scrape.js [scrape.js args...]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, log } from './util.js';

const MAX_ATTEMPTS = 25;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'scrape.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (r.status === 0) process.exit(0);
  log(`scrape.js exited with ${r.status ?? r.signal} (attempt ${attempt}/${MAX_ATTEMPTS}); resuming…`);
  // --full would ignore the resume skip and start over every time, so drop it on restarts.
  const i = process.argv.indexOf('--full');
  if (i !== -1) process.argv.splice(i, 1);
}
log('scrape did not finish after repeated restarts; building with what was collected');
process.exit(1);
