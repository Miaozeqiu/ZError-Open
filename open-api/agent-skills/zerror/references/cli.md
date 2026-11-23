# CLI operations

All business commands emit one JSON response: `{"ok":true,"result":...}` or `{"ok":false,"error":...}`. `--help` and `--version` emit plain text. Exit codes: 0 success, 2 invalid CLI arguments, 3 connection failure, 4 operation/task failure, 5 wait timeout. `--no-start` prevents automatic desktop startup.

## Discover instead of guessing

```sh
zerror methods
zerror models list
zerror folders list
zerror questions search --json '{"keyword":"search text","page":1,"pageSize":20}'
zerror config set theme '"dark"'
zerror tools list --json '{"url":"https://example.com/"}'
```

For shell quoting differences, supply JSON through stdin: `zerror call METHOD --json -`. Use a pipe/stdio writer appropriate to the environment. Do not expose credentials while preparing input.

## Direct tools and Agent jobs

```sh
zerror browser open https://example.com/
zerror tools run --json '{"sessionId":"FROM_BROWSER_OPEN","name":"browser_get_page","args":{}}' --wait
zerror tools run --json '{"sessionId":"FROM_BROWSER_OPEN","name":"browser_click","args":{"ref":"FROM_FRESH_SNAPSHOT"}}' --wait
zerror tools result CONVERSATION_ID --json '{"messageId":"TASK_MESSAGE_ID"}'
zerror agent run "Requested multi-step task" --wait --timeout 600
```

`agent status` is a bounded preview. `tools result` reads a complete tool result, subject to the response size limit. For long tasks, omit `--wait`, retain the returned IDs and query later. An approvals/login/verification wait can need interaction in the desktop app; it is not a successful terminal outcome.

Website-specific workflows come from Open packages; inspect `websites list`, install the matching repository when needed with `websites install`, then discover its tools. Do not reconstruct platform-specific login or submission scripts in this skill.

## Credential payloads

These shapes are for a secure stdin writer, not values to paste into chat or shell history:

- `accounts set --json -`: `{host, account, password}`.
- `models add --json -`: `{name, baseUrl, apiKey, protocol, model:{modelId, supportsTools, maxTokens}}`; use `platformId` instead of creating another provider when appropriate.
- `models key --json -`: `{platformId, apiKey}`.
- `config set --json -`: `{key:"search.tavilyApiKey", value:...}` (or another supported search key).

Select a model using the returned internal model ID: `models select --json '{"id":"ID","role":"agent"}'`. Roles are `answer`, `summary`, `agent`; `id:null` clears a selection. Configuration success waits for durable storage; concurrent GUI edits are retained.

## Data writes

```sh
zerror folders add --json '{"name":"Requested folder"}'
zerror questions add --json '{"content":"Question","answer":"Answer","folderId":123}'
zerror questions update --json '{"id":456,"answer":"Corrected answer"}'
```

When deletion was requested, pass the relevant ID and `confirm:true`. Website removal also removes local website configuration, credentials and experience. Required repositories are protected by the app.

## Installing and upgrading this skill

```sh
zerror skill install --agent codex
zerror skill install --agent claude
zerror skill install --agent cursor
zerror skill install --agent pi
zerror skill install --agent opencode
zerror skill install --dir /absolute/path/to/skills
zerror skill list
zerror skill check
zerror skill update
```

`--dir` names a skills root; the installer creates its `zerror` child. `--no-auto-update` during installation keeps that installation manual. `skill update` never silently overwrites edited or unrelated files. The skill manager does not require the desktop process to be running, but operating the app does.
