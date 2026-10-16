# anybrowser

Let any AI agent drive a real browser that is already logged in. No browser extension, any browser, any agent that speaks MCP.

## Why

Agents are good at using websites. The browsers they are given are the problem. An automation browser starts empty: no logins, no history, and a fingerprint that many sites block on sight. A browser extension fixes that, but it ties you to one browser and one assistant, it has to be installed and allowed, and the extension may limit which sites the agent can touch.

anybrowser gives the agent a normal browser window with its own profile. You log in once, by hand, and the session stays. Each profile is for one site or purpose, such as `gmail-in-chrome`, so a mistake can only ever reach that one account.

It works with the Chromium browsers you already have (Chrome, Brave, Edge, Arc, Vivaldi, Opera) or Playwright's own Chromium, and with any agent host that supports MCP: Claude Code, Codex, Cursor, Gemini CLI and more.

## How it works

```
agent session ─┐
agent session ─┼─ anyb mcp ──► anyb daemon ──► one browser per profile
agent session ─┘  (stdio)      (one per user)    ├─ work-in-chrome
                                                 └─ shop-in-brave
```

- Your agent host runs `anyb mcp`. It starts a background daemon on first use and forwards to it.
- The daemon owns every browser. Agent sessions share them, and each session works in its own tab.
- The browser tools are Playwright MCP's, unchanged except that each takes a `profile` argument.
- A profile's browser closes after 10 idle minutes, and the daemon exits once nothing is connected. Logins are written to disk before either closes.
- Each profile's traffic passes through a small proxy inside the daemon, which enforces the allowed-sites list below.

## Status

Pre-release, not on npm yet. What works: profiles on installed Chromium browsers, login by hand, every Playwright MCP browser tool, shared sessions, idle shutdown, the allowed-sites list, and `anyb install` for Claude Code.

Not yet: Firefox and WebKit, installed-browser detection outside macOS (Playwright's Chromium works everywhere), and `anyb install` for hosts other than Claude Code.

## Quick start

You need Node 22.12 or newer.

```
git clone https://github.com/DmitriiSer/anybrowser.git
cd anybrowser
npm install
npm run build
npm link
anyb install
```

`anyb install` registers the MCP server with Claude Code and copies the agent skill. For any other MCP host, `anyb install --print` prints a config snippet to paste.

Make a profile and sign in to it once:

```
anyb profile add work chrome
anyb profile login work-in-chrome https://github.com/login
```

Sign in in the window that opens. Then open a new agent session and ask it to use the `work-in-chrome` profile. `anyb --help` lists every command.

## Safety

An agent in a logged-in browser can do real things, so the design limits how far a mistake can reach:

- **One login per profile.** A profile holds one site or purpose. Whatever goes wrong in `gmail-in-chrome` cannot touch any other account, and none of it touches your everyday browser. A profile can hold more than one login when a task needs it, for example a site that signs in through Google. Every login you add widens what a mistake in that profile can reach, so keep profiles as narrow as the work allows.
- **Optional allowed-sites list.** A profile can be pinned to the sites it is for. Every page load, every subresource (scripts, images, requests the page makes), every hop of a redirect chain and every WebSocket is checked against the list, and the first one that leaves it is refused. The check is by host and port, so the path of an HTTPS address is invisible to it: allowing `example.com` allows every page on it. A refusal is written to the daemon log and reported to the agent as an error that names the blocked address. A page that loads while some of its own requests are refused is not an error: the result carries a note naming the refused hosts and saying the page may be incomplete. You set the list with `anyb profile add <name> <browser> --allow <list>` or `anyb profile set <id> allowedOrigins=<list>`, and no MCP tool can change it. It is re-read on every request, so an edit applies to a running session at once, and a connection that is already open to a host you take off the list is closed within a second. Entries are literal: `example.com` does not cover `www.example.com`, `*.example.com` does not cover `example.com` itself, and a port has to be written out (`localhost:3000`, or `localhost:*` for any), so most sites need both the apex and the wildcard. A local dev server is reachable only if it is on the list; a pinned profile reaches nothing else on your machine. Two things are not covered. WebRTC connections are not checked. And an agent that can run shell commands can edit `profile.json` itself, so the list means nothing against one. It is a guard rail against a wrong turn, not a sandbox.
- **Ask before anything irreversible.** The agent is instructed to confirm with you before it posts, sends, buys, deletes or changes settings. This is guidance to the agent, not a technical lock, so watch the window when it matters. It stays visible by default for that reason.

## Development

Work is test-first: a failing test, then the code that makes it pass. `CLAUDE.md` has the rules, and `docs/DESIGN.md` records each design decision and why.

```
npx playwright install chromium   # once, for the browser tests
npm test                          # everything
npm run test:unit                 # no browser
npm run test:browser              # headless Chromium against local pages only
npm run typecheck
npm run format:check
```

Settings: `ANYBROWSER_HOME` moves the state directory from `~/.anybrowser`. `ANYBROWSER_IDLE_MS`, or `idleMinutes` in `config.json`, changes the idle timeout, and `off` disables it. `ANYBROWSER_HEADLESS=1` forces every browser headless.

MIT licensed.
