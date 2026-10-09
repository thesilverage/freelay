# Freelay

Relay, but free.

Fork of [Relay](https://github.com/No-Instructions/Relay), with an open,
self-hosted control plane using Ed25519 key authentication.

Work in progress: not yet a production release. Use a test vault and keep backups.

## Use

1. Build with `npm ci && npm run build`.
2. Install `main.js`, `manifest.json`, and `styles.css` in
   `<vault>/.obsidian/plugins/freelay/`. Requires Obsidian 1.11.5 or newer.
3. Enable Freelay, configure your server's canonical HTTPS URL, then reload the
   plugin. There is no default hosted service.
4. Show your public key and give it to the administrator to become an Owner,
   or connect and paste an invitation code to join as a User.
5. Owners create relays and shared folders; invited Users sync only what they
   have access to. Keys and membership are per installation and server URL.

Private keys use Obsidian Secret Storage. There is no key export/import or
automatic migration from Relay. A lost key requires administrator recovery or
a new invitation. Changing servers does not transfer content or membership.

See the [server operator guide](https://github.com/thesilverage/freelay-server/blob/main/docs/OPERATIONS.md)
for setup and recovery. Mobile runtime validation is still outstanding.

## Development

`npm test` runs the public Freelay suite. To include the real server smoke test:

```sh
FREELAY_SERVER_BIN=../freelay-server/crates/target/debug/freelay npm test
```

`npm run lint` and `npm run build` check the plugin. The encrypted upstream
`__tests__/` suite is retained for merge compatibility; it is not part of
the default test command. Copyright and license notices are preserved in
[LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
