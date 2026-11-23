---
name: zerror
description: Use the installed ZError desktop app through its CLI to configure models or website accounts, manage question banks, operate its browser, and run or inspect its Agent tasks. Use when the user asks to work with ZError or data and browser sessions already in that app.
metadata:
  version: "1.0.0"
---

# ZError

Use `zerror` to operate the user's installed app in the same local user session. Cloud agents need an explicitly connected local execution environment. The CLI reuses its data, browser and credential isolation. Inspect `zerror --help`, `zerror status` and `zerror methods` for the installed capabilities. If it is not on PATH, use the installed `zerror-cli` executable, or the app's Settings → General → Install command line action. Do not download or replace the desktop app unless the user requests it.

## Choose the execution path

- Use `questions`, `folders`, `config`, `models` and `accounts` commands for direct data/configuration requests. `zerror methods` returns the exact JSON parameter schemas.
- Use `tools list` and `tools run` for a known tool operation; this does not need an additional model request. For a website, list tools with its URL so installed Open packages can be resolved.
- Use `agent run "task" --wait` when the user wants ZError's Agent to plan and execute the task. Avoid delegating an action you can perform directly just to receive another model response.
- A browser opened with `browser open URL` returns its `sessionId`. Supply that session to subsequent tool calls. Use the app's existing browser instead of launching an unrelated browser. Observe before acting and verify a write through a fresh observation or an explicit receipt.

Examples and credential input are in [references/cli.md](references/cli.md); read it when those operations are needed. The running app's schemas take precedence over examples.

## Track exactly one task

`agent run` and `tools run` return `id` (conversation) and `messageId` (task). Keep both. `--wait` waits for that task. Query or stop it with:

```sh
zerror agent status CONVERSATION_ID --message MESSAGE_ID
zerror agent stop CONVERSATION_ID --message MESSAGE_ID
```

A later message in the same conversation is a different task. Do not treat its result as the original task's result or stop it accidentally. A timeout does not cancel a task. On timeout, disconnect or an uncertain write receipt, query the original task/page before deciding whether to retry. Never automatically repeat a submission.

Pending approval, login or verification is reported by task status; let the app handle its existing approval/credential flow. Do not treat an accepted task or dispatched click as completed work. Report the actual result and remaining wait state.

## Credentials and changes

Use `--json -` for credential input from a secure source. Do not put passwords or API keys in command arguments, chat transcripts, skill files or task text. Prefer the app's credential input flow if no secure input source is available. The Agent should work with credential references, not retrieve decrypted credentials.

Deletion commands require `confirm:true`; send that only when deletion is authorized by the user's request. Installing a skill does not authorize unrelated tasks or writes.

## Skill maintenance

This skill is distributed by ZError Open. `zerror skill check` checks managed installations; `zerror skill update` upgrades them independently of desktop releases. The app also checks registered installations in the background when automatic updates are enabled. No update check is needed before each task. Local modifications are preserved by refusing an automatic overwrite. Keep personal task notes outside this managed skill folder.

New or updated files become available according to the host Agent's discovery/reload behavior. A currently running conversation may retain an older loaded skill; use a new turn/session or its documented reload action when needed.
