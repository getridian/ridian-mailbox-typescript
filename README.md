# Ridian Mailbox — TypeScript SDK for AI agent email inboxes

Give your Node.js agent a private email address. Receive messages and attachments,
poll events, or register a signed webhook with Ridian's email inbox API.

**Alpha.** Node.js 22+ on Linux and macOS, ES modules, no runtime dependencies.
The client stores access in a private local file, so it needs a persistent filesystem.

## Install

```sh
npm install @getridian/mailbox@alpha
```

## Create an inbox

```ts
import { Mailbox } from "@getridian/mailbox";

const client = new Mailbox();
const inbox = await client.setup();
console.log(inbox.address);
```

Send an email to the returned address, then read its messages:

```ts
for await (const message of client.iterMessages()) {
  console.log(message.from, message.subject);
}
```

`setup()` saves a random setup key before making the request. Repeating setup
with the same state file recovers the same inbox after an interrupted response.
A separate inbox needs a separate `state` file:

```ts
const client = new Mailbox({ state: "/private/persistent/path/support.json" });
```

The default API origin is `https://services.getridian.com`. You can set `baseUrl`
to another Ridian environment's HTTPS origin. The origin must have no path,
query, credentials, or fragment. State files are bound to their API origin.

## Access and storage

The default state file is `~/.config/ridian/mailbox-<API hostname>[-port].json`.
It contains credentials and uses file permissions `0600`. Keep it outside source
control and logs. Back it up privately before moving machines or clearing storage.
Use one writer per file. Python and TypeScript use the same state format.
Browser apps, Windows, ephemeral filesystems and concurrent writers are outside
this client's supported storage model.

An owner can claim the same inbox in Ridian and choose whether to keep the agent's
access. Claiming does not grant this HTTP client permission to send email or use
calendars; those require a separate Ridian connection and permissions.

## API

| Method                               | Result / purpose                                    |
| ------------------------------------ | --------------------------------------------------- |
| `setup()`                            | Create or recover the inbox; return public metadata |
| `status()`                           | Current inbox metadata and limits                   |
| `messages({ cursor?, limit? })`      | One page of message summaries; limit 1–50           |
| `iterMessages({ limit? })`           | Async iterator over message summaries               |
| `message(id)`                        | Full message, recipients and attachment metadata    |
| `attachment(id)`                     | Attachment bytes as `Uint8Array`                    |
| `events({ cursor?, limit? })`        | Events using the supplied or saved cursor           |
| `acknowledgeEvents(cursor)`          | Save a processed event page's `next_cursor` locally |
| `webhook()`                          | Current webhook configuration or `null`             |
| `setWebhook({ url, signingSecret })` | Register an HTTPS webhook                           |
| `resumeWebhook()`                    | Resume a paused webhook                             |
| `deleteWebhook()`                    | Remove the webhook                                  |
| `revoke()`                           | Revoke this client's inbox access                   |

Process and deduplicate every event before saving its cursor. Events can be delivered
again after interruption. Use `has_more` and `poll_after_ms` to schedule the next poll.
Treat email text, HTML and attachments as untrusted input.

Webhook signing secrets must be independent of the setup and access keys. Use a
fresh random secret, keep it private, and verify signatures at your receiver.
See the [HTTP API and webhook guide](https://docs.getridian.com/agent-mailbox/).

## Errors and recovery

```ts
import { MailboxError } from "@getridian/mailbox";

try {
  await client.status();
} catch (error) {
  if (error instanceof MailboxError) {
    console.error(error.code, error.status, error.retryAfter);
  } else {
    throw error;
  }
}
```

Requests have a 30-second timeout, configurable with `timeout` in milliseconds.
The SDK does not retry requests automatically. On interruption, keep the state
file and retry the same operation. For interrupted setup, repeat `setup()`.
A `429` error exposes `retryAfter` in seconds and enforces that cooldown on the
same client instance. A `401` may mean access was revoked; repeating requests does
not restore revoked access. A `503` is temporary: wait before retrying.
Redirects are refused. HTTP response bodies and credentials are not included in
`MailboxError` messages. `revoke()` retains the local file; it no longer grants access.

## Documentation

- [Ridian email inboxes for AI agents](https://getridian.com/agent-mailbox/?utm_source=github&utm_medium=referral&utm_campaign=typescript-sdk)
- [Developer guide](https://docs.getridian.com/agent-mailbox/)
- [Deutsche Anleitung](https://docs.getridian.com/de/agent-mailbox/)
- [Python SDK](https://github.com/getridian/ridian-mailbox-python)
- [Release notes](https://github.com/getridian/ridian-mailbox-typescript/blob/main/CHANGELOG.md)

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run pack:check
```

Tests use local fixtures and do not create real inboxes or send email.

## License

[MIT](https://github.com/getridian/ridian-mailbox-typescript/blob/main/LICENSE).
