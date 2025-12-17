## Rewrite Policy (team alignment)

### Default stance

- **No rewrite by default.**
- This codebase already contains hard-won safety rails (tenant enforcement, immutable ledger, idempotency, locks, outbox/events). Rewriting usually deletes those rails first, and production incidents follow.

### When a rewrite is allowed

A rewrite is only approved if at least one is true:

- **Security risk**: current approach cannot be hardened safely (with a clear incident risk).
- **Broken architecture**: a core invariant cannot be maintained without replacing a component.
- **Proven performance issue**: measured bottleneck cannot be solved with refactor/scaling.
- **Unmaintainable complexity**: measurable developer cost with repeated failure modes.

### Required proposal (before any rewrite work starts)

Any rewrite proposal must include:

- **Scope**: what is being rewritten, what is not.
- **Migration plan**: how we move traffic/data incrementally.
- **Timeline**: realistic milestones (with a kill switch).
- **Rollback plan**: how we revert safely under load.
- **Measurable benefit**: target metrics (latency, cost, error rate, dev velocity).

### Preferred alternatives (use first)

- **Refactor-in-place**: improve the existing module while preserving invariants.
- **Strangler pattern**: build a new component alongside the old one and migrate endpoints/flows gradually.
- **Feature flags**: ship in small increments and validate in production safely.

### Non-negotiables (must survive any refactor or replacement)

- Tenant boundary enforcement (JWT.companyId)
- Ledger immutability + reversals (no ledger edits)
- HTTP idempotency for write actions (`Idempotency-Key`)
- Event outbox pattern with retries
- Idempotent consumers for events
- Concurrency locks for money/inventory actions


