# Security notes

## 2026-11-07: ephemeral test-server credential in diagnostic output

- Type: credential exposure in a development tool result, limited to an isolated
  synthetic OpenCode server. No operator credential was used.
- Location: bootstrap worker diagnostic stdout before final harness capture;
  not a tracked source-file secret. Credential value intentionally omitted.
- Severity: limited to the lifetime/reachability of that disposable process.
- Containment reported by worker: server terminated and fixture removed; that
  process-scoped credential is no longer useful. Do not copy diagnostic stdout.
- Prevention: final `scripts/harness.ts` captures startup output internally and
  exposes only authenticated request operations, never the credential in reports.
- Integrator verification after review corrections: integration and artifact tests
  rerun, 5 tests passing, 47 assertions, with no credential printed in their outputs.

## 2026-11-07: test transport option forwarding

- Independent review identified that forwarding arbitrary Bun RequestInit options
  could redirect a credential-bearing test request through a Unix socket.
- No exploitation or additional exposure was observed. The issue was found in
  review of the disposable harness, not a published plugin.
- Harness requests now use an explicit allowlist, reject transport overrides and
  enforce origin, redirects and a fixed timeout ceiling. Negative integration
  assertions passed in the integrator rerun; independent re-review remains pending.

This is not evidence that every future logging path is safe. Keep raw process
stdout, authorization headers and sensitive request payloads out of diagnostics.
