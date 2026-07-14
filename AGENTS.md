# Working agreement

## Workstreams

- **UI and review flow** — `src/client/**` and client tests.
- **Collectors and site semantics** — `src/server/adapters/**`, product evidence, adapter tests.
- **Publishing and data integrity** — orchestrator, QA, repositories, Google Sheets publisher.
- **Release** — CI, versioning, deployment and browser acceptance checks.

The coordinating thread owns integration and production deployment. Parallel work must use a separate branch/worktree, declare the files it owns, and avoid editing files assigned to another active workstream.

## Definition of done

1. Add a focused regression test for the reported failure.
2. Run `pnpm typecheck`, `pnpm test`, and `pnpm build`.
3. Test the affected employee path in the deployed web interface.
4. Never turn access blocks or quota failures into zero reviews.
5. Never commit `.env*`, tokens, browser captures, temporary HTML, or collected output dumps.

## Versions

Use Conventional Commits (`fix:`, `feat:`, `chore:`). Release Please maintains the changelog, version, Git tag and GitHub Release through an automated release pull request.
