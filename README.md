# anybrowser

Let any AI agent drive a real browser that is already logged in. No browser extension, any browser, any agent that speaks MCP.

## Why

Agents are good at using websites. The browsers they are given are the problem. An automation browser starts empty: no logins, no history, and a fingerprint that many sites block on sight. A browser extension fixes that, but it ties you to one browser and one assistant, it has to be installed and allowed, and the extension may limit which sites the agent can touch.

anybrowser gives the agent a normal browser window with its own profile. You log in once, by hand, and the session stays. Each profile is for one site or purpose, such as `gmail-in-chrome`, so a mistake can only ever reach that one account.

It is being built for the Chromium browsers you already have (Chrome, Edge, Brave and others), plus Firefox and WebKit builds from Playwright, and for any agent host that supports MCP: Claude Code, Codex, Cursor, Gemini CLI and more.

## Quick start

Developer preview. It is not on npm yet, so you build it from source. Today this gives you the shared background daemon and one tool, `daemon_status`. Browser control comes next.

You need Node 22.12 or newer.

```
git clone https://github.com/DmitriiSer/anybrowser.git
cd anybrowser
npm install
npm run build
npm link
```

Three commands:

```
anyb status   # is the daemon running? prints its version, pid and session count
anyb mcp      # what an agent host runs; starts the daemon if needed
anyb stop     # stop the daemon
```

Add it to an agent host. For Claude Code:

```
claude mcp add --scope user anybrowser -- anyb mcp
```

For any other MCP host, register a stdio server with this command:

```json
{ "command": "anyb", "args": ["mcp"] }
```

Open two agent sessions and ask each to call `daemon_status`. Both report the same daemon and a session count of two.

## Safety

An agent in a logged-in browser can do real things, so the design limits how far a mistake can reach. These are the rules browser control is being built to:

- **One login per profile.** A profile holds one site or purpose. Whatever goes wrong in `gmail-in-chrome` cannot touch any other account, and none of it touches your everyday browser. A profile can hold more than one login when a task needs it, for example a site that signs in through Google. Every login you add widens what a mistake in that profile can reach, so keep profiles as narrow as the work allows.
- **Optional allowed-sites list.** A profile can be pinned to the sites it is for. Every page load, every subresource (scripts, images, requests the page makes), every hop of a redirect chain and every WebSocket is checked against the list, and the first one that leaves it is refused. The check is by host and port, so the path of an HTTPS address is invisible to it: allowing `example.com` allows every page on it. A refusal is written to the daemon log and reported to the agent as an error that names the blocked address. You set the list with `anyb profile add <name> <browser> --allow <list>` or `anyb profile set <id> allowedOrigins=<list>`, and no MCP tool can change it. It is re-read on every request, so an edit applies to a running session at once, and a connection that is already open to a host you take off the list is closed within a second. Entries are literal: `example.com` does not cover `www.example.com`, `*.example.com` does not cover `example.com` itself, and a port has to be written out (`localhost:3000`, or `localhost:*` for any), so most sites need both the apex and the wildcard. A local dev server is reachable only if it is on the list; a pinned profile reaches nothing else on your machine. Two things are not covered. WebRTC connections are not checked. And an agent that can run shell commands can edit `profile.json` itself, so the list means nothing against one. It is a guard rail against a wrong turn, not a sandbox.
- **Ask before anything irreversible.** The agent is instructed to confirm with you before it posts, sends, buys, deletes or changes settings. This is guidance to the agent, not a technical lock, so watch the window when it matters. It stays visible by default for that reason.
