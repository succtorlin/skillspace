#!/usr/bin/env node
// npm run open - opens the SkillSpace console in the browser.
//
// The server writes this boot's console link (with its per-boot API secret)
// to a 0600 file, and prints it on stdout only when stdout is a terminal - a
// service's log is often world-readable. This reads that file. Same location
// rules as the server (lib/console-link.js): SKILLSPACE_HOME/console-link
// when SKILLSPACE_HOME is set, else ~/Library/Application Support/SkillSpace
// on macOS, else $XDG_STATE_HOME/skillspace (or ~/.local/state/skillspace).
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { defaultFile } = require('../lib/console-link.js');

const file = defaultFile();
let link;
try {
  link = fs.readFileSync(file, 'utf8').trim();
} catch (e) {
  console.error(`No console link at ${file} (${e.code || e.message}).`);
  console.error('Is SkillSpace running? Start it with `npm start`; the file is written at boot and removed on shutdown.');
  process.exit(1);
}
if (!/^http:\/\/localhost:\d+\/\?auth=[0-9a-f]{64}$/.test(link)) {
  console.error(`${file} does not hold a SkillSpace console link; refusing to open it.`);
  process.exit(1);
}

if (process.platform === 'darwin') {
  // argv, not a shell string: the link never reaches a shell.
  execFile('open', [link], (err) => {
    if (err) {
      console.error('Could not run `open`:', err.message);
      console.log(link);
      process.exit(1);
    }
  });
} else {
  // No portable "open a URL" here; print it for the user to open.
  console.log(link);
}
