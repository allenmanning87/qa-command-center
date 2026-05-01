You are executing the deploy phase for Allen Command Center. This skill is invoked when Allen says "ready" after the `/qa` sign-off ("QA passed — say ready to deploy to production").

## Steps

1. **Stage changed files** by specific file name — never `git add -A` or `git add .`:
   ```
   git add public/js/views/foo.js public/css/main.css ...
   ```
   Include all modified tracked files and relevant untracked files. Exclude `data/` files (runtime data, not source) and any `.env` files.

2. **Commit** with a conventional commit message derived from the wip AC title:
   - `feat:` for new features
   - `fix:` for bug fixes or improvements
   - `chore:` for tooling, workflow, or docs-only changes
   ```
   git commit -m "feat: time tracker improvements and workflow system"
   ```

3. **Push the branch**:
   ```
   git push -u origin <branch-name>
   ```

4. **Create the PR** using `gh pr create`. Include the acceptance criteria verbatim from `docs/designs/wip-acceptance-criteria.md` in the PR body under an `## Acceptance criteria` heading:
   ```
   gh pr create --title "..." --body "..."
   ```

5. **Babysit CI** — poll `gh pr checks <number>` every 30 seconds:
   - If no checks are reported after 60 seconds total, treat as "CI not configured" and proceed to merge.
   - If any check fails, report which checks failed and stop — do not merge.
   - If all checks pass, proceed to merge.

6. **Merge the PR**:
   ```
   gh pr merge <number> --merge --delete-branch
   ```

7. **Pull latest main**:
   ```
   git checkout main && git pull origin main
   ```

8. **Delete the wip AC file** — it is gitignored so no commit is needed:
   ```
   rm docs/designs/wip-acceptance-criteria.md
   ```
   The criteria are now captured permanently in the PR description.

9. **Report** the PR URL and confirm the merge and pull were successful.

10. **Check for learnings** — after a successful merge, check whether the session introduced anything worth persisting:
    - `CLAUDE.md`: any new project conventions or patterns?
    - Memory (`~/.claude/projects/.../memory/`): any user feedback, project decisions, or reference info worth saving?
    - Skill files (`.claude/commands/*.md`): any new workflow insight to bake into a skill?
    Only update where there is a genuine new insight — do not pad existing content.
