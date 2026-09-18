# anybrowser: Design

Status: agreed 2026-09-17. Decisions came out of a design interview; each one records the choice and the reason so it can be revisited on purpose, not by accident.

## Goal

Let any LLM agent drive a browser that already holds the user's logins, with full interaction (snapshot, click, type, screenshot, console, network, tabs), in any browser engine, without installing a browser extension. Anything that speaks MCP can use it: Claude Code, Codex, Cursor, Gemini CLI, and others.

The starting point was a small single-site fetch script: it existed because plain HTTP fetches got blocked, while a real browser profile with a real session did not. This project generalises that idea.

## Non-goals

- Attaching to the user's everyday browser profile. Chrome 136+ refuses remote debugging on the default profile directory, and Edge and Brave inherited that.
- Cloning cookies out of the everyday profile. Works today, breaks whenever cookie encryption changes, and touches Keychain.
- Driving the locally installed Firefox or Safari. Playwright can only drive its own Firefox build, and its WebKit is not Safari.app.
- Click-level safety guards. There is no generic way to tell "post a comment" from "open a menu".

## Decisions

1. **The gap is real sessions.** Playwright MCP already does every action we need but in a fresh, bot-shaped browser. We add persistent, logged-in profiles.

2. **Dedicated persistent profiles, one login per site.** Each profile is its own user-data directory. The user logs in once; the session persists. Isolation is also the safety boundary: a mistake reaches one account.

3. **MCP server plus a CLI.** The agent uses MCP tools (screenshots come back as images, inputs are typed). Profile management is rare, so it gets a CLI and is also exposed as MCP tools so the agent can offer to open a login page. No desktop app.

4. **Three engines in v1.** Chromium-family browsers use the installed binary (Chrome, Chromium, Brave, Edge, Arc, Vivaldi, Opera, auto-detected) with Playwright's Chromium as fallback. Firefox and WebKit always use Playwright's bundled builds, downloaded on first use. All engines launch through `launchPersistentContext`, so there is one launch path and no debug-port juggling.

5. **Daemon owns the browsers.** One daemon per user holds every open profile's browser. Any agent session can use any profile, with many tabs. The daemon exits after `idleMinutes` (default 10) without tool calls; each profile's browser closes after the same idle period on its own. RAM cost is roughly 150-300 MB per open profile plus 50-150 MB per tab.

6. **Profile naming is `<name>-in-<browser>`.** The user supplies `name` and `browser`; the tool composes the id. Examples: `reddit-in-chrome`, `gmail-in-firefox`.

7. **Headed by default, headless per profile.** Headed avoids headless fingerprinting and lets the user watch. Headed versus headless is a launch flag, so there is no automatic fallback; the user sets `headless: true` on a profile once they know the site tolerates it. The agent may read the flag, not change it.

8. **Snapshot first, screenshot on demand.** The agent works from the accessibility snapshot with element refs. Screenshots and coordinate clicks (the `vision` capability) are the fallback for canvas pages and verification. The skill says so explicitly.

9. **Embed `@playwright/mcp`, do not reimplement it.** `createConnection( config, contextGetter)` gives the full tool set per profile in-process, including the snapshot and ref engine. The router around it stays thin so a later swap to an own implementation is contained.

10. **Concurrency.** Three layers:
    - Daemon spawn: try the socket; on refusal take an `O_EXCL` lock file with pid. The winner spawns the daemon detached and waits for the socket; losers poll the socket up to ~10 s. Stale sockets and dead-pid locks are removed.
    - Profile launch: a per-profile "launching" promise map inside the single-threaded daemon serialises concurrent launches.
    - Tabs: one persistent context per profile, one embedded Playwright MCP connection per (session, profile) over that shared context. Sessions see each other's tabs but keep their own current tab. Two sessions acting on the same tab is not prevented; the skill tells the agent to open its own tab.

11. **Node/TypeScript.** Forced by decision 9. Go would add a hop, not remove one, since playwright-go spawns the Node driver anyway. Time goes to page loads and model turns, not to the orchestration layer.

12. **Login flow has no site knowledge.** `profile_login(profile, url)` opens the URL in a headed window, brings it to front, returns. The agent asks the user to log in, then verifies with a snapshot. It detects that a login is needed the same way: it sees a login form. If the profile is headless, `profile_login` relaunches it headed for that session.

13. **Every tool takes a required `profile` argument.** Stateless and explicit, like `tabId` in Claude in Chrome. About 8 tokens per call.

14. **Tool surface.** Playwright MCP's core tools plus `vision`, passed through under their upstream names with `profile` added. Removed: `browser_close` (would kill a shared profile) and `browser_install` (the launcher handles downloads). Added: `profile_list`, `profile_create(name, browser, headless?)`, `profile_delete`, `profile_login(profile, url)`, `profile_status`, `daemon_status`.

15. **Safety, three layers.** Profile isolation; optional `allowedOrigins` per profile (Playwright MCP implements it, off by default); a skill rule to confirm before irreversible actions (post, send, buy, delete, change settings).

16. **On-disk layout.**

    ```
    ~/.anybrowser/
      config.json              # { idleMinutes: 10 }
      daemon.sock  daemon.lock  daemon.log
      profiles/
        reddit-in-chrome/
          profile.json         # name, browser, headless, allowedOrigins,
                               # executablePath, createdAt
          user-data/           # the browser's own directory
          downloads/
    ```

    `browser` is one of `chrome`, `chromium`, `brave`, `edge`, `arc`, `vivaldi`, `opera`, `firefox`, `webkit`. The resolved executable path is stored at create time so a later rename or uninstall fails loudly.

17. **Wire protocol is MCP over a Unix socket.** The daemon runs an MCP server on the socket with newline-delimited JSON-RPC. The per-session stdio proxy pipes stdin/stdout to the socket, spawns the daemon if absent, and sends its package version on connect. A daemon of a different version finishes serving and exits when idle, so `npm update` takes effect without a manual stop. One socket connection equals one session.

18. **Distribution.** npm package `anybrowser`, binary `anyb`. Subcommands: `anyb mcp` (stdio proxy), `anyb daemon` (internal), `anyb profile list|add|remove|login|set`, `anyb status`, `anyb stop`, `anyb install`, `anyb uninstall`. Install paths, in order of preference:

    - `npx anybrowser install` is the universal path. With no flags it detects which MCP hosts are present and offers each. The flag `--host claude|codex|cursor|gemini|claude-desktop` picks one without prompting. Per host it registers the MCP server and copies the skill into that host's skills directory where the host has one. The server command is always `npx -y anybrowser mcp`; only the config file and format differ. `--print` outputs a generic MCP config snippet for any host not on the list. `anyb uninstall` reverses an install.
    - Host-native packaging where a host has it, as a convenience on top of the above. The first is a Claude Code plugin, a `plugin.json` under `.claude-plugin/` that bundles the MCP server and the skill. Install it with `/plugin marketplace add DmitriiSer/anybrowser` and then `/plugin install anybrowser`. Others follow when their hosts grow an equivalent.
    - The skill lives at `skills/anybrowser/SKILL.md`, the open Agent Skills layout, so `npx skills add DmitriiSer/anybrowser` also works.

    Host adapters are a small table (config path, format, skills directory), so adding a host is data, not code. `anybrowser-mcp` is also free on npm and can become an alias package if search traffic warrants it.

    macOS first; Linux is a detection path table away; Windows later. Playwright engine downloads happen on first use with a progress message returned to the agent.

19. **Testing.** Unit (vitest): naming and config, browser detection against a fake filesystem, lock and stale-socket logic. Integration, on Playwright's Chromium against a locally served page: spawn race (20 proxies, one daemon), per-session current tab, idle shutdown with seconds-scale `idleMinutes`, version-mismatch restart, `profile_login` relaunching headed. No tests against real sites; manual smoke test with a real profile at the end. Daemon lifecycle tests are written first.

20. **Skill plus MCP, not skill instead of MCP.** Some hosts, Claude Code among them, defer MCP tool schemas (only names sit in context until first use), so the token argument for a skill-only design is weak, and a skill cannot return images. The skill carries the playbook: snapshot before screenshot, open your own tab, confirm irreversible actions, how login works.

## Architecture

```
Agent session A                Agent session B
   |  stdio                       |  stdio
   v                              v
 anyb mcp (proxy)              anyb mcp (proxy)
   |  MCP over unix socket        |
   +--------------+---------------+
                  v
            anyb daemon (one per user, idle-exits)
              |  profile router: required `profile` arg on every tool
              |
              +-- reddit-in-chrome  : persistent context (Chrome, headed)
              |     +-- playwright-mcp connection for session A
              |     +-- playwright-mcp connection for session B
              +-- gmail-in-firefox  : persistent context (Playwright Firefox)
                    +-- playwright-mcp connection for session A
```

## Build order

1. Walking skeleton: daemon on the socket, stdio proxy, one hard-coded profile on Playwright's Chromium, tools passed through with `profile`.
2. Profiles: `profile.json`, browser detection, `profile_*` tools and CLI, headed login flow, Firefox and WebKit engines.
3. Hardening: spawn race, idle shutdown, version handshake, `allowedOrigins`, the integration tests.
4. Ship: skill, `anyb install` with host adapters, Claude Code plugin manifest, README, npm publish.

## Lessons from the prototype

Before this project there was a single-site script: launch a browser on a dedicated profile, fetch one authenticated URL, quit. What it taught:

- Launching and killing a browser per request is too slow for interactive use. Hence the daemon (decision 5).
- Detecting login by a site-specific cookie name does not generalise. Hence the site-agnostic login flow (decision 12).
- Line-oriented stdout tokens worked for a script, but typed MCP results are better for interaction (decision 3).
- "Only ever log in to one site in that profile" is the right safety model and became decision 2.
