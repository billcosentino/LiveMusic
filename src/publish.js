// Publishes site/ to the gh-pages branch of this repo's GitHub remote (served by GitHub Pages).
// The branch holds only the latest build (force-pushed), so nightly data updates don't bloat the repo history.
//   node src/publish.js
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, SITE, log } from './util.js';

const OUT = path.join(ROOT, '.publish');
const git = (args, cwd = OUT) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

if (!fs.existsSync(path.join(SITE, 'data.js'))) {
  console.error('site/data.js missing; run node src/build.js first');
  process.exit(1);
}
const remote = git(['remote', 'get-url', 'origin'], ROOT);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);
for (const f of fs.readdirSync(SITE)) fs.copyFileSync(path.join(SITE, f), path.join(OUT, f));
fs.writeFileSync(path.join(OUT, '.nojekyll'), ''); // serve files as-is

git(['init', '-q', '-b', 'gh-pages']);
git(['config', 'user.name', git(['config', 'user.name'], ROOT) || 'gig-calendar']);
git(['config', 'user.email', git(['config', 'user.email'], ROOT) || 'gig-calendar@users.noreply.github.com']);
git(['add', '-A']);
git(['commit', '-q', '-m', `Calendar update ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`]);
git(['push', '-q', '--force', remote, 'gh-pages']);
log(`published site/ to gh-pages on ${remote}`);
