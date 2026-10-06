# opencode-stale-reasoning

A client-side workaround for OpenCode v2 sessions stuck on rejected encrypted reasoning.
It applies when OpenAI Responses requests can reach different accounts, organizations, or resources.

For example, CLIProxyAPI or LiteLLM can switch between ChatGPT subscription logins and API keys, or between Azure resources.
This switch can follow an HTTP 429 or the expiry of a proxy's session pin (the rule that keeps a session on one account).

## Problem

OpenAI Responses reasoning models return reasoning as `encrypted_content`.
Only the issuing account or organization can decrypt this content.
OpenCode replays it on later turns.
If the request reaches another account, the upstream returns HTTP 400.
Every retry carries the same items, so the session stays stuck.

## How it works

The plugin uses three session hooks:

1. `http.response` records HTTP 400 errors with JSON error code `invalid_encrypted_content` or `thinking_signature_invalid`.
   It also recognizes messages starting with "The encrypted content for item <id> could not be verified".
   It marks every encrypted reasoning item carried by the rejected request as foreign to that session.
   If the message names an item absent from that request, it marks nothing.
2. `retry` allows one immediate retry (OpenCode attempt 2). OpenCode does not normally retry HTTP 400.
   It acts only on a recorded rejection with the same error message.
3. `http.request` removes `encrypted_content` and `id` from marked reasoning items and keeps their readable summary.
   It removes items without a readable summary.
   Messages, tool calls, and tool results stay unchanged.
   Reasoning produced later by the new upstream replays normally.

The upstream names only the first item it cannot decrypt.
In one observed request, it named one of three foreign items.
Marking only that item requires a failed attempt for each item.
The plugin therefore marks all encrypted reasoning items in the rejected request.

One request fails before any output, then the session continues on the retry.
In production behind a proxy that switches accounts, a session that had been stuck for two hours recovered on the plugin's first retry.

## Install

1. Copy or clone this repository into `~/.config/opencode/plugins/stale-reasoning/`.
2. Add `"./plugins/stale-reasoning"` to the `plugins` array in `~/.config/opencode/opencode.jsonc`.
   The path is relative to that configuration file. Keep any existing entries.
3. Restart OpenCode:

   ```sh
   opencode service restart
   ```

The plugin has no runtime dependencies.
Its entry point exports a plain `{ id, setup }` object.

## Limits

- OpenCode v2 only. The plugin uses the v2 `http.request`, `http.response`, and `retry` session hooks.
  Tested with OpenCode v2.0.24. The tests run on Node 22. No v1 support.
- HTTP only. Per the [OpenCode plugin documentation](https://opencode.ai/v2/docs/build/plugins), HTTP hooks do not see native WebSocket traffic.
  The plugin has no effect on that traffic.
- Only the error shapes listed above match.
  Other messages match only when they carry one of the two listed codes.
  For example, "reasoning `encrypted_content` was not issued to this caller" matches only with one of those codes.
- State stays in memory. After OpenCode restarts, the first request carrying foreign reasoning fails again, then recovers.
  The plugin retains up to 512 sessions and targets 256 item ids per session.
  It never evicts ids carried by the rejected request, so a larger request can exceed that target.
- After a switch, the model sees summaries of earlier reasoning instead of the full reasoning.
  This has the same trade-off as LiteLLM's [`strip_encrypted_reasoning_from_input`](https://github.com/BerriAI/litellm/blob/main/litellm/responses/utils.py).
  The effect on answer quality is not measured.
- This is a workaround, not a fix. It does not prevent the one failing request.
  Avoiding mixed credential pools, as the CLIProxyAPI maintainer advises, avoids the error entirely.

## Alternatives

- [vitkuz573/opencode-fix-encrypted-content](https://github.com/vitkuz573/opencode-fix-encrypted-content) (MIT) removes all encrypted reasoning before every request with `experimental.chat.messages.transform`.
  It also provides a repair script for sessions already broken in the database.
  It runs that script automatically after a session error about encrypted content.
- [AnonymoDGH/opencode-encrypted-content-fix](https://github.com/AnonymoDGH/opencode-encrypted-content-fix) (MIT) removes the encrypted content from reasoning older than a configurable age, default three minutes, before every request.
  It does the same for reasoning older than the OpenCode process start.
- This plugin removes only encrypted reasoning carried by a request that an upstream rejected.
  It keeps full reasoning until a switch happens. Choose it when switches are occasional.
  We did not test whether the alternatives load in OpenCode v2.

Core proposals [#48908](https://github.com/anomalyco/opencode/pull/48908) and [#48918](https://github.com/anomalyco/opencode/pull/48918) are open and not merged as of 2026-10-06.
If either merges, this plugin can become unnecessary.

## Tests and background

Run `node test.mjs` or `npm test` from this repository.
The tests run 21 checks with no network access.
See [CLIProxyAPI issue #6420](https://github.com/router-for-me/CLIProxyAPI/issues/6420) for the background.

## License

MIT. See [LICENSE](LICENSE).
