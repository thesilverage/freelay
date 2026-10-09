# Contributing to Freelay

Keep changes small, explain why they are needed, and include tests. Preserve the
upstream CRDT/sync engine and public interfaces wherever possible; place Freelay
control-plane behavior in its dedicated modules and adapters.

Use this fork's issues and pull requests, not upstream commercial support
channels. Discuss authentication, permissions, deletion, storage, and large
refactors before implementing them. Do not post private keys, invitation codes,
bearer tokens, or unredacted diagnostic logs.

Run `npm test`, `npm run lint`, and `npm run build`. The public tests are under
`tests/freelay/`; encrypted upstream tests remain untouched for merge
compatibility. They are not required by the default public test command.

Contributions are distributed under the MIT license. Retain existing attribution
and third-party license notices. Freelay is an independent fork, not the upstream
Relay service.
