#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT = 15000;

function usage() {
  console.log(`Usage: node chrome_cdp.mjs <command> [options]

Commands:
  start       Launch headless Chrome and wait for CDP
  list        List browser targets
  new         Open a new tab
  navigate    Navigate an existing page
  eval        Evaluate JavaScript in a page
  screenshot  Capture a page screenshot
  click       Click viewport coordinates
  wait        Wait for page title/text/URL conditions
  turnstile   Detect and click a Cloudflare Turnstile checkbox through CDP
  close       Close the browser through CDP

Common options:
  --host <host>                 CDP host (default: 127.0.0.1)
  --port <port>                 CDP port (default: 9222)
  --target <substring>          Match a page by URL or title
  --timeout <ms>                Timeout for startup or wait operations

start options:
  --url <url>                   Initial URL
  --profile <path>              Dedicated Chrome profile directory
  --proxy <url>                 Proxy server, for example http://127.0.0.1:7897
  --ua <user-agent>             User-Agent override
  --exe <path>                  Chrome executable

Other options:
  --expr <javascript>           Expression for eval
  --out <path>                  Output file for screenshot
  --x <number> --y <number>     Viewport coordinates for click
  --title-contains <text>       wait condition
  --title-not-contains <text>   wait condition
  --text-contains <text>        wait condition
  --url-contains <text>         wait condition
  --url-not-contains <text>     wait condition`);
}

function parseArgs(argv) {
  const command = argv.shift();
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      opts._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[key] = next;
      i += 1;
    } else {
      opts[key] = true;
    }
  }
  return { command, opts };
}

function required(value, label) {
  if (value === undefined || value === true || value === '') {
    throw new Error(`${label} is required`);
  }
  return value;
}

function asNumber(value, fallback, label) {
  if (value === undefined || value === true) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number`);
  return number;
}

function hostOf(opts) {
  return opts.host || DEFAULT_HOST;
}

function portOf(opts) {
  return asNumber(opts.port, DEFAULT_PORT, 'port');
}

function cdpBase(opts) {
  return `http://${hostOf(opts)}:${portOf(opts)}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function chromeCandidates() {
  const candidates = [];
  if (process.platform === 'win32') {
    if (process.env.PROGRAMFILES) candidates.push(path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (process.env['PROGRAMFILES(X86)']) candidates.push(path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser');
  }
  return candidates;
}

function findChrome(explicitPath) {
  const candidates = explicitPath ? [explicitPath] : chromeCandidates();
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
    return candidate;
  }
  throw new Error('Chrome executable not found; pass --exe');
}

function chromeVersion(exe) {
  try {
    const output = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    const match = output.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (match) return match[1];
  } catch {
    // Fall back to a current stable user-agent shape.
  }
  return '131.0.0.0';
}

function normalUserAgent(exe) {
  const version = chromeVersion(exe);
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

async function requestJson(url, options = {}) {
  const timeout = options.timeout ?? 5000;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function tryVersion(opts) {
  try {
    return await requestJson(`${cdpBase(opts)}/json/version`, { timeout: 1500 });
  } catch {
    return null;
  }
}

async function waitForVersion(opts, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await requestJson(`${cdpBase(opts)}/json/version`, { timeout: 1500 });
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`CDP did not start at ${cdpBase(opts)}: ${lastError?.message || 'timeout'}`);
}

async function getTargets(opts) {
  return requestJson(`${cdpBase(opts)}/json/list`, { timeout: 5000 });
}

function findPage(targets, match) {
  const pages = targets.filter(target => target.type === 'page');
  if (match) {
    const found = pages.find(target => (target.url || '').includes(match) || (target.title || '').includes(match));
    if (found) return found;
    throw new Error(`No page target matches: ${match}`);
  }
  if (pages.length > 0) return pages[0];
  throw new Error('No page targets found');
}

function connect(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 0;
    let settled = false;

    const api = {
      send(method, params = {}) {
        return new Promise((resolveSend, rejectSend) => {
          const id = ++nextId;
          pending.set(id, { resolve: resolveSend, reject: rejectSend });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() {
        ws.close();
      },
    };

    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };

    ws.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new Error(`WebSocket failed: ${webSocketUrl}`));
      }
    };

    ws.onclose = () => {
      for (const entry of pending.values()) entry.reject(new Error('WebSocket closed'));
      pending.clear();
    };

    ws.onopen = () => {
      settled = true;
      resolve(api);
    };
  });
}

async function withPage(opts, callback) {
  const targets = await getTargets(opts);
  const target = findPage(targets, opts.target);
  const client = await connect(target.webSocketDebuggerUrl);
  try {
    return await callback(target, client);
  } finally {
    client.close();
  }
}

async function pageState(client) {
  const result = await client.send('Runtime.evaluate', {
    expression: `({ title: document.title, url: location.href, text: (document.body && document.body.innerText || '').slice(0, 2000), ua: navigator.userAgent })`,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error('Page evaluation failed');
  return result.result.value;
}

function jsonPrint(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function start(opts) {
  const host = hostOf(opts);
  const port = portOf(opts);
  if (await tryVersion(opts)) throw new Error(`CDP is already listening at ${cdpBase(opts)}; use another port or close it first`);
  const exe = findChrome(opts.exe);
  const profile = path.resolve(opts.profile || path.join(os.tmpdir(), `codex-chrome-headless-${port}`));
  fs.mkdirSync(profile, { recursive: true });
  const url = opts.url || opts._[0] || 'about:blank';
  const args = [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-blink-features=AutomationControlled',
    `--remote-allow-origins=*`,
    `--remote-debugging-address=${host}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--user-agent=${opts.ua || normalUserAgent(exe)}`,
  ];
  if (opts.proxy) args.push(`--proxy-server=${opts.proxy}`);
  args.push(url);
  const child = spawn(exe, args, { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  const version = await waitForVersion(opts, asNumber(opts.timeout, DEFAULT_TIMEOUT, 'timeout'));
  jsonPrint({
    pid: child.pid,
    port,
    host,
    profile,
    url,
    proxy: opts.proxy || null,
    cdp: cdpBase(opts),
    browser: version.Browser,
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
  });
}

async function list(opts) {
  const targets = await getTargets(opts);
  jsonPrint(targets.map(target => ({
    id: target.id,
    type: target.type,
    title: target.title,
    url: target.url,
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
  })));
}

async function newPage(opts) {
  const url = required(opts.url || opts._[0], 'url');
  const target = await requestJson(`${cdpBase(opts)}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', timeout: 10000 });
  jsonPrint(target);
}

async function navigate(opts) {
  const url = required(opts.url, 'url');
  await withPage(opts, async (_, client) => {
    await client.send('Page.navigate', { url });
    await sleep(asNumber(opts.wait, 1000, 'wait'));
    jsonPrint(await pageState(client));
  });
}

async function evaluate(opts) {
  const expression = required(opts.expr || opts._.join(' '), 'expr');
  await withPage(opts, async (_, client) => {
    const result = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    }
    jsonPrint(result.result.value);
  });
}

async function screenshot(opts) {
  const output = path.resolve(opts.out || `screenshot-${Date.now()}.png`);
  await withPage(opts, async (_, client) => {
    await client.send('Page.enable');
    const result = await client.send('Page.captureScreenshot', {
      format: opts.format || 'png',
      captureBeyondViewport: Boolean(opts.full),
    });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, Buffer.from(result.data, 'base64'));
    console.log(output);
  });
}

async function click(opts) {
  const x = asNumber(opts.x, undefined, 'x');
  const y = asNumber(opts.y, undefined, 'y');
  if (x === undefined || y === undefined) throw new Error('x and y are required');
  await withPage(opts, async (_, client) => {
    await client.send('Page.bringToFront');
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(250);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(100);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(asNumber(opts.wait, 750, 'wait'));
    jsonPrint(await pageState(client));
  });
}

function conditionSatisfied(state, opts) {
  const checks = [];
  if (opts['title-contains']) checks.push(state.title.includes(opts['title-contains']));
  if (opts['title-not-contains']) checks.push(!state.title.includes(opts['title-not-contains']));
  if (opts['text-contains']) checks.push(state.text.includes(opts['text-contains']));
  if (opts['url-contains']) checks.push(state.url.includes(opts['url-contains']));
  if (opts['url-not-contains']) checks.push(!state.url.includes(opts['url-not-contains']));
  if (checks.length === 0) throw new Error('At least one wait condition is required');
  return checks.every(Boolean);
}

function nodeAttributes(node) {
  const attrs = {};
  const list = node.attributes || [];
  for (let i = 0; i < list.length; i += 2) attrs[list[i]] = list[i + 1];
  return attrs;
}

function findTurnstileNodes(root) {
  const labels = [];
  const inputs = [];
  function walk(node) {
    const attrs = nodeAttributes(node);
    if (node.nodeName === 'INPUT' && attrs.type === 'checkbox') inputs.push(node);
    if (node.nodeName === 'LABEL') {
      const childInput = (node.children || []).find(child => child.nodeName === 'INPUT' && nodeAttributes(child).type === 'checkbox');
      if (childInput) labels.push({ label: node, input: childInput });
    }
    for (const child of node.children || []) walk(child);
    for (const shadow of node.shadowRoots || []) walk(shadow);
  }
  walk(root);
  return { label: labels[0]?.label, input: labels[0]?.input || inputs[0], labels, inputs };
}

async function resolveNode(client, nodeId) {
  const resolved = await client.send('DOM.resolveNode', { nodeId });
  if (!resolved.object?.objectId) throw new Error('CDP could not resolve checkbox node');
  return resolved.object.objectId;
}

async function clickTurnstileNode(client, node) {
  const objectId = await resolveNode(client, node.nodeId);
  await client.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function(){ this.click(); return true; }',
    returnByValue: true,
  });
}

function challengeFrameFor(targets, page) {
  return targets.find(target =>
    target.type === 'iframe' &&
    target.parentId === page.id &&
    (target.url || '').includes('challenges.cloudflare.com')
  ) || targets.find(target =>
    target.type === 'iframe' && (target.url || '').includes('challenges.cloudflare.com')
  );
}

function pageLooksChallenged(state) {
  const title = state.title || '';
  const text = state.text || '';
  return /(\u8bf7\u7a0d\u5019|Just a moment|Checking your Browser)/i.test(title) || (text.trim() === '' && title !== '');
}

async function turnstile(opts) {
  const timeoutMs = asNumber(opts.timeout, 30000, 'timeout');
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastState = null;

  while (Date.now() < deadline) {
    const targets = await getTargets(opts);
    const page = findPage(targets, opts.target);
    const pageClient = await connect(page.webSocketDebuggerUrl);
    try {
      lastState = await pageState(pageClient);
    } finally {
      pageClient.close();
    }

    if (!pageLooksChallenged(lastState)) {
      jsonPrint({ passed: true, attempts, state: lastState });
      return;
    }

    const frame = challengeFrameFor(targets, page);
    if (frame) {
      const frameClient = await connect(frame.webSocketDebuggerUrl);
      try {
        await frameClient.send('DOM.enable');
        const document = await frameClient.send('DOM.getDocument', { depth: -1, pierce: true });
        const nodes = findTurnstileNodes(document.root);
        if (nodes.label || nodes.input) {
          attempts += 1;
          if (attempts > 3) break;
          await clickTurnstileNode(frameClient, nodes.label || nodes.input);
          console.log('Turnstile attempt ' + attempts + ': clicked ' + (nodes.label ? 'label' : 'checkbox'));
        }
      } finally {
        frameClient.close();
      }
    }

    await sleep(1500);
  }

  throw new Error('Turnstile did not pass within ' + timeoutMs + 'ms; last state: ' + JSON.stringify(lastState));
}

async function wait(opts) {
  const timeoutMs = asNumber(opts.timeout, DEFAULT_TIMEOUT, 'timeout');
  const deadline = Date.now() + timeoutMs;
  let lastState;
  while (Date.now() < deadline) {
    const state = await withPage(opts, async (_, client) => pageState(client));
    lastState = state;
    if (conditionSatisfied(state, opts)) {
      jsonPrint(state);
      return;
    }
    await sleep(500);
  }
  throw new Error(`Wait timed out: ${JSON.stringify(lastState)}`);
}

async function close(opts) {
  const version = await requestJson(`${cdpBase(opts)}/json/version`, { timeout: 5000 });
  const client = await connect(version.webSocketDebuggerUrl);
  try {
    await client.send('Browser.close');
  } catch {
    // Browser.close often closes the WebSocket before replying.
  } finally {
    client.close();
  }
  console.log(`Closed ${cdpBase(opts)}`);
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || opts.help) return usage();
  const commands = { start, list, new: newPage, navigate, eval: evaluate, screenshot, click, wait, turnstile, close };
  const handler = commands[command];
  if (!handler) throw new Error(`Unknown command: ${command}`);
  return handler(opts);
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
