# Summary

<!-- 1–3 sentences describing what this PR does and why. -->

## Linked task / milestone

- TaskList: <!-- T-NNN -->
- Milestone: <!-- M0 / M1 / M2 -->

## Type of change

- [ ] feat — new functionality
- [ ] fix — bug fix
- [ ] chore — tooling, build, config
- [ ] docs — documentation only
- [ ] refactor — no behavior change
- [ ] test — tests only

## Required reviews before merge

- [ ] **`security-auditor`** approved (mandatory if PR touches `programs/`, `.env*`, `docker-compose.yml`, or any auth/crypto code)
- [ ] **`qa-test-eng`** verified (regression suite green; any new behavior covered by E2E or integration test)

## Self-checklist

- [ ] No Cyrillic / non-English content in committed files
- [ ] No commit attribution to the human PM; no `Co-Authored-By: Claude` trailer
- [ ] No secrets in code, logs, or test fixtures
- [ ] `pnpm lint` clean
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` clean
- [ ] If touching `programs/`: `anchor build` + `anchor test` clean
- [ ] If new env var added: also added to `.env.example` + `turbo.json` `globalEnv`
- [ ] If new package added: workspace deps respected, no version drift

## How tested

<!-- Describe verification steps run locally / on devnet. -->

## Notes for reviewers

<!-- Anything reviewers should know: tradeoffs, follow-ups, known gaps. -->
