You are executing the build phase for Allen Command Center. This skill is invoked when Allen says "go" after approving a `/design` session.

## Steps

1. **Check for uncommitted changes**
   ```
   git status
   ```
   If there are uncommitted tracked-file changes, list them and ask Allen whether to include them in the new branch.

2. **Ensure main is up to date**
   ```
   git fetch origin
   git status
   ```
   If `main` is behind remote, run `git pull origin main` and report.

3. **Generate branch name** from the feature description in `docs/designs/wip-acceptance-criteria.md`:
   - Prefix: `feat/` (new feature), `fix/` (bug fix or improvement), `chore/` (tooling, workflow, docs)
   - Slug: short kebab-case summary of the feature
   - Example: "Timer clock + alphabetize + 0-hours fix" → `fix/timer-clock-alphabetize-zero-hours`

4. **Create and check out the branch**
   ```
   git checkout -b <branch-name>
   ```
   Report the branch name to Allen.

5. **Implement** — Claude builds the code changes in-conversation using Edit/Write tools. Follow all conventions in `CLAUDE.md`. Do not create new files unless genuinely necessary.

6. **Chain to review** — once all changes are saved, immediately invoke `/review`. Do not wait for Allen.
