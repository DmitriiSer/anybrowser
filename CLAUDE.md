# anybrowser

Design and decisions: `docs/DESIGN.md`. Read it before changing architecture.

## Privacy

This is a public repository. Never write personal information into any file, fixture, snapshot, screenshot, log sample, or commit message:

- No real names, email addresses, usernames, or account handles.
- No absolute home-directory paths. Write `~/` or `$HOME`.
- No personal domains, hostnames, IPs, or internal URLs. Use `example.com`.
- No cookies, tokens, session values, or browser profile contents, even expired or redacted-looking ones.
- Example profiles use generic sites and names: `reddit-in-chrome`, `gmail-in-firefox`.

Browser profiles live outside the repo under `~/.anybrowser/` and must never be copied, symlinked, or referenced by absolute path from inside it. Tests run only against locally served pages.
