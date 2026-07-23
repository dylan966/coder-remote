# Coder Workspace Switcher

Single page to view/switch all workspaces, entering each one's claude session. Mobile supported.

## Run

```bash
CODER_URL=... CODER_TOKEN=... npm start   # :8080
```

## Test

```bash
npm test           # unit tests (protocol/fuzzy/config)
npm run smoke      # end-to-end (needs server running + a real token)
```

## Deploy (always-on workspace + coder_app)

See deploy/coder_app.tf.snippet; create the token with `coder secret create switcher-token --env CODER_TOKEN`.
