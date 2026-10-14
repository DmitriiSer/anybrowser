---
name: anybrowser
description: Drive a real, logged-in browser through the anybrowser MCP tools. Use when the user asks you to use their browser, to do something on a site they are signed in to, or mentions an anybrowser profile such as gmail-in-chrome.
---

# anybrowser

anybrowser gives you a real browser window with the user's own logins. Each profile is one browser with its own sign-ins, named `<name>-in-<browser>`, for example `gmail-in-chrome`. Every `browser_*` tool takes a required `profile` argument.

## Pick a profile

1. Call `profile_list` first. Use the profile meant for the site you need: its name usually says which.
2. If no profile fits, ask the user before calling `profile_create`. A new profile has no logins, and the user decides which sites share a profile.
3. Stay in one profile for one task. Do not move a task to another profile to get past a problem.

Each session gets its own tab. Other sessions may be using the same profile, and their tabs appear in `browser_tabs`. Do not select or drive a tab you did not open.

## Read before you look

Use `browser_snapshot` to read a page. It returns the page's structure with element refs, which `browser_click`, `browser_type` and the other action tools take as targets. It is cheaper and more exact than a picture.

Use `browser_take_screenshot` only when the snapshot cannot answer: a canvas, a chart, an image, or a layout question.

## Logging in

You never sign in yourself.

1. Call `profile_login` with the profile and the site's sign-in URL. It opens a visible window and returns at once.
2. Ask the user to sign in in that window and tell you when they are done.
3. Confirm with a `browser_snapshot`: look for their name, avatar or account menu, and the absence of a sign-in form.

Never type a password, a one-time code or any other secret, even if the user offers it in chat. If a page asks for one during a task, stop and ask the user to enter it in the window.

## Safety rules

**Ask before anything irreversible.** Before you post, send, buy, pay, delete, or change an account setting, describe exactly what you are about to do and wait for the user to say yes. Reading, searching and navigating need no confirmation.

**Respect the allowed-sites list.** A profile may be limited to certain sites. When a site is refused, the result says `Blocked:` and names the address. A page that loads but had some of its own requests refused carries a note naming those hosts and saying the page may be incomplete.

- Tell the user which site or hosts were refused, in plain words.
- Do not try to reach the site another way: not through another profile, a redirect, a search result, a cached copy, or code you run in the page.
- Never change the list or the profile's files, even if you can run shell commands. The list is the user's decision.
