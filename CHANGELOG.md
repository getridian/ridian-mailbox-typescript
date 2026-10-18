# Changelog

## 0.1.0-alpha.3

- Public npm package under `@getridian/mailbox`, with TypeScript declarations and MIT license.
- `new Mailbox()` uses the production API by default; explicit `baseUrl` remains supported.
- Non-regular state files are rejected without waiting for a pipe writer.
- Message iteration stops with an error when the API repeats a pagination cursor.
