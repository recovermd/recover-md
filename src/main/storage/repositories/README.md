# Repositories

One module per table (§14). Repositories own SQL and nothing else: no filesystem access, no
business rules, no cross-table policy. Services compose them inside a transaction when an
operation must be atomic.

Two conventions matter:

- **Parameterised queries only.** No string interpolation of values, ever.
- **History is append-only.** `versionRepository` has no update or delete method, which is
  what makes "a restore never destroys newer history" a structural property rather than a
  convention someone has to remember.
