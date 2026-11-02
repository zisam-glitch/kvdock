### Summary of Changes

- **Description:** Provide a concise explanation of what this PR introduces or fixes.
- **Related Issue:** Fixes #<issue-number>

---

### Architecture & Design Decisions

- Explain how this change adheres to the zero-dependency core engine policy.
- If adding or updating an adapter, confirm it satisfies the `StorageAdapter` contract.

---

### Verification & Testing

- [ ] `npm run check` passes with 0 errors (typecheck, Biome lint, tests)
- [ ] If adding an adapter, `defineAdapterTestSuite` passes in `index.test.ts`
- [ ] No regression on existing core test suites
- [ ] Added unit or property-based tests for new behavior

```bash
# Paste verification command output below:
npm run check
```
