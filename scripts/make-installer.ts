// Compatibility command; all installer work belongs to the standalone Windows pipeline.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const root = process.cwd();
const child = spawn(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), 'scripts/build-windows.ts'], { cwd: root, stdio: 'inherit', shell: false, windowsHide: true });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
