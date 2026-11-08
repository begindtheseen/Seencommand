# Local setup

Requirements: Apple Silicon macOS, Node/npm dependencies already used by Seen Command, Git, and Ollama.
No Python service, vector database, or new model is required.

```bash
npm install
ollama list
npm run intelligence:verify
npm run intelligence:test
SEEN_NO_OPEN=1 PORT=4599 node engine/server.mjs
```

Optional configuration is JSON copied from `config/seen-command.example.json` and selected through:

```bash
SEEN_INTELLIGENCE_CONFIG=/absolute/path/to/local-config.json npm run intelligence:verify
```

Keep the real config outside Git if it contains environment-specific values. Secrets remain in the
existing secure Settings/runtime `.env`; never put them in intelligence config. Remote escalation is
off in the example. Model downloads require separate storage/license/runtime review and explicit owner
authorization.

For a packaged local verification build, use `npm run app:package` and launch the artifact under
`dist/mac-arm64` with an isolated `SEEN_HOME`/port. Preserve the stable installed application; do not
replace it for this work.
