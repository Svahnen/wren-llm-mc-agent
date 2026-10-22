# Contributing

Thanks for your interest. This is a small personal project; issues and pull requests are welcome.

- **Licence of contributions.** By submitting a contribution you agree that it is licensed under the Apache License 2.0 (inbound = outbound, Apache-2.0
  section 5). Please sign off your commits (`git commit -s`, Developer Certificate of Origin).
- **Tests.** `npm run install:bot && npm test` must pass offline (no Minecraft server, GPU or network). Java mods: `cd voice-mod && ./build.sh`, `cd map-addon && ./build.sh`.
- **Never run tests or scripts against a server you do not own.** Do not add tests that need a live server to the default suites.
- **No private data.** No real player names, chat, coordinates of a real world, tokens, hostnames or IP addresses in code, tests, fixtures or issues. Redact logs before you paste them.
- **No third-party assets.** No Minecraft assets, mappings, model weights, recordings of real voices or code you do not have the right to relicense.
- **Style.** Plain Node ESM, no new npm dependencies without a good reason (brain, mind, voice and report have none).
- **Conduct.** See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security problems: [SECURITY.md](SECURITY.md).
