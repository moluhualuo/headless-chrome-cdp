---
name: headless-chrome-cdp
description: Launch and control Google Chrome in headless mode through the Chrome DevTools Protocol for persistent tab navigation, page inspection, screenshots, clicks, and CDP-based Cloudflare Turnstile detection. Use when a task requires a running browser or reproduces the Windows proxy and user-agent workflow; do not use when a plain HTTP fetch is sufficient.
metadata:
  short-description: Control headless Chrome through CDP
---

# Headless Chrome CDP

Use `scripts/chrome_cdp.mjs` as the default entry point. It requires Node 20 or newer and uses only built-in modules.

## Start a persistent session

Use a dedicated profile and a port that is not already in use:

```powershell
node scripts/chrome_cdp.mjs start --url https://www.google.com/ --port 9222
```

For a site that requires a local proxy, add `--proxy`:

```powershell
node scripts/chrome_cdp.mjs start --url https://linux.do/ --port 9223 --proxy http://127.0.0.1:7897
```

The script launches `--headless=new`, sets a normal Chrome user agent, hides the Windows process window, and waits until `/json/version` is reachable. If Chrome exits before the debug port listens, rerun the launch outside the sandbox.

## Control the running session

```powershell
node scripts/chrome_cdp.mjs list --port 9222
node scripts/chrome_cdp.mjs new --port 9222 --url https://www.baidu.com/
node scripts/chrome_cdp.mjs eval --port 9222 --target baidu --expr "document.title"
node scripts/chrome_cdp.mjs navigate --port 9222 --target linux.do --url https://linux.do/
node scripts/chrome_cdp.mjs wait --port 9222 --target linux.do --url-contains linux.do --timeout 20000
node scripts/chrome_cdp.mjs turnstile --port 9222 --target linux.do --timeout 30000
node scripts/chrome_cdp.mjs close --port 9222
```

`--target` matches a page URL or title substring. If omitted, the script uses the first page target.

## CDP-only Turnstile flow

`turnstile` does not use screenshots or image recognition. It:

1. Reads page title, URL, and body text through `Runtime.evaluate`.
2. Finds the challenge iframe whose `parentId` matches the page target and whose URL contains `challenges.cloudflare.com`.
3. Calls `DOM.getDocument` with `depth: -1` and `pierce: true` to inspect the iframe's closed shadow DOM.
4. Finds the checkbox as `LABEL > INPUT[type=checkbox]`.
5. Calls `DOM.resolveNode` and `Runtime.callFunctionOn` to click the label.
6. Rechecks the page through CDP and attempts at most three clicks.

## Rules that matter

- Keep one profile per debug port. Reusing another running Chrome profile can make the new URL open in the wrong browser and prevent CDP from listening.
- CDP is a control and inspection protocol; it does not make Cloudflare trust the browser by itself. Use a normal Chrome user agent, a working proxy/IP, and a dedicated fresh profile.
- Never leave the user agent as `HeadlessChrome` when the target site rejects it.
- If the challenge passes but the destination shows a connection timeout, keep the proxy and browser in the same session and retry navigation.
- If `turnstile` cannot pass after three CDP clicks, stop and report the final title, URL, and challenge state.

## Script behavior

The script is self-contained: Chrome discovery, launch, CDP HTTP and WebSocket calls, page evaluation, navigation, waiting, screenshots, coordinate clicks, shadow-DOM Turnstile inspection, and browser shutdown all run through `scripts/chrome_cdp.mjs`.