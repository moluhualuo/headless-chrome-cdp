# Cloudflare Turnstile through CDP

Use this workflow only for a page the Operator asked to open or inspect. CDP controls and inspects the browser; it does not guarantee that Cloudflare accepts the browser fingerprint.

## Preferred flow

1. Start a dedicated browser with a normal Chrome user agent and, when needed, the configured proxy:
   ```powershell
   node scripts/chrome_cdp.mjs start --url https://linux.do/ --port 9223 --proxy http://127.0.0.1:7897
   ```

2. Check whether the page already passed:
   ```powershell
   node scripts/chrome_cdp.mjs eval --port 9223 --target linux.do --expr "({title:document.title,url:location.href,text:document.body.innerText.slice(0,200),ua:navigator.userAgent})"
   ```

3. Run the CDP-only Turnstile command:
   ```powershell
   node scripts/chrome_cdp.mjs turnstile --port 9223 --target linux.do --timeout 30000
   ```

4. Confirm the final state:
   ```powershell
   node scripts/chrome_cdp.mjs eval --port 9223 --target linux.do --expr "({title:document.title,url:location.href,text:document.body.innerText.slice(0,500)})"
   ```

## What the command does internally

- It finds the page target matching `--target`.
- It finds a related iframe target with a `challenges.cloudflare.com` URL.
- It calls `DOM.getDocument` with `{ depth: -1, pierce: true }` so Chrome returns the closed shadow DOM tree.
- It locates `LABEL > INPUT[type=checkbox]`.
- It resolves the label node with `DOM.resolveNode`.
- It clicks the label with `Runtime.callFunctionOn`.
- It rechecks the page through CDP and stops after three attempts.

## Failure modes

- `HeadlessChrome` in the user agent is a common blocker. Restart with the script default or another normal Chrome UA.
- `ERR_CONNECTION_TIMED_OUT` after the challenge means the challenge callback ran but the destination route failed. Restart with the proxy and retry.
- A challenge can initially change to `Just a moment...` and then issue another challenge frame. Re-query targets after each click instead of caching the old iframe target.
- If three CDP clicks fail, stop and report the final title, URL, and whether the destination body contains real content.