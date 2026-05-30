#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const url = process.argv[2];
if (!url) {
  console.error('usage: verify-slide-controls.mjs <url-or-file-url>');
  process.exit(64);
}

const chrome =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const userDataDir = await mkdtemp(join(tmpdir(), 'slide-controls-'));
const chromeProc = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=0',
  `--user-data-dir=${userDataDir}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const cleanup = async () => {
  chromeProc.kill('SIGTERM');
  await new Promise((resolve) => {
    if (chromeProc.killed) return setTimeout(resolve, 250);
    chromeProc.once('exit', resolve);
    setTimeout(resolve, 1000);
  });
  await rm(userDataDir, { recursive: true, force: true });
};

process.on('exit', () => chromeProc.kill('SIGTERM'));
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(143); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readDevToolsPort() {
  const activePortFile = join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 80; i += 1) {
    try {
      const [port] = (await readFile(activePortFile, 'utf8')).trim().split('\n');
      if (port) return port;
    } catch {
      await sleep(125);
    }
  }
  throw new Error('Chrome DevTools port did not become available');
}

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    fetch(`http://127.0.0.1:${port}${path}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
        return res.json();
      })
      .then(resolve, reject);
  });
}

async function cdpCall(ws, method, params = {}) {
  cdpCall.id = (cdpCall.id || 0) + 1;
  const id = cdpCall.id;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
  });
}

try {
  const port = await readDevToolsPort();
  const targets = await getJson(port, '/json/list');
  const target = targets.find((item) => item.type === 'page') || targets[0];
  if (!target?.webSocketDebuggerUrl) throw new Error('No debuggable Chrome page target found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  await cdpCall(ws, 'Runtime.enable');
  await cdpCall(ws, 'Page.enable');
  await cdpCall(ws, 'Page.navigate', { url });
  await sleep(1500);

  const result = await cdpCall(ws, 'Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const read = () => ({
        title: document.querySelector('#controlTitle')?.textContent?.trim() || '',
        nextVisible: !!document.querySelector('#nextBtn')?.offsetParent,
        prevVisible: !!document.querySelector('#prevBtn')?.offsetParent,
        navCount: document.querySelectorAll('#nav button').length,
        progress: document.querySelector('#progress')?.style?.width || ''
      });
      const before = read();
      document.querySelector('#nextBtn')?.click();
      setTimeout(() => resolve({ before, after: read() }), 900);
    })`,
  });

  const check = result.result.value;
  if (!check.before.nextVisible || !check.before.prevVisible || check.before.navCount < 2) {
    throw new Error(`controls missing or incomplete: ${JSON.stringify(check)}`);
  }
  if (check.before.title === check.after.title && check.before.progress === check.after.progress) {
    throw new Error(`next button did not advance slide: ${JSON.stringify(check)}`);
  }

  console.log(JSON.stringify({ ok: true, ...check }, null, 2));
  await cdpCall(ws, 'Browser.close').catch(() => {});
  await cleanup();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await cleanup();
  process.exit(1);
}
