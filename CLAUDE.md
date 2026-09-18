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

## Development

Test-driven, always. No production code without a failing test that demands it.

1. Red: write one failing test for the next small behaviour. Run it and confirm it fails for the expected reason, not because of a typo or a missing import.
2. Green: write the least code that makes it pass.
3. Refactor: clean up code and tests with the suite green. Then pick the next behaviour.

- A bug fix starts with a test that reproduces the bug.
- Test behaviour through public seams: the CLI, the socket protocol, MCP tool calls. Do not test private functions or mock internals you own.
- Prefer real child processes, real sockets, and a locally served page over mocks. Poll for conditions with a deadline instead of sleeping a fixed time.
- A change is done when `npm run typecheck`, `npm test`, and `npm run format:check` all pass.
- When delegating work to a subagent, put this section's rules in its brief. It does not inherit them by reading the task alone.

Exceptions: throwaway spikes outside the repo, and changes that are only docs or configuration.
