Spawn a fresh Claude CLI terminal using the Shell.Application COM object.

**Arguments:** $ARGUMENTS

## Step 1 — Resolve target and pre-seed

Parse `$ARGUMENTS` by these rules (applied in order):

| Arguments pattern | `$target` | `$preseed` |
|---|---|---|
| *(blank)* | `C:\Git-Repositories\qa-command-center` | *(none)* |
| First token starts with `/` | `C:\Git-Repositories\qa-command-center` | full arguments string |
| First token is a word (repo name), no second token | `C:\Git-Repositories\<first-token>` | *(none)* |
| First token is a word (repo name), second token starts with `/` | `C:\Git-Repositories\<first-token>` | second token |

**Before proceeding:** verify `$target` exists as a directory on disk. If it does not, output: `Error: path not found — $target` and stop.

## Step 2 — Open the terminal

**If $preseed is blank** — run this bash command, substituting `$target`:
```bash
powershell.exe -Command "\$sh = New-Object -ComObject Shell.Application; \$root = '$target'; \$claude = \"\$env:APPDATA\\npm\\claude\"; \$sh.ShellExecute('cmd.exe', \"/k cd /d \`\"\$root\`\" && \`\"\$claude\`\"\", \$root, 'open', 1)"
```

**If $preseed is non-blank** — run this bash command, substituting `$target` and `$preseed`:
```bash
powershell.exe -Command "\$sh = New-Object -ComObject Shell.Application; \$root = '$target'; \$claude = \"\$env:APPDATA\\npm\\claude\"; \$sh.ShellExecute('cmd.exe', \"/k cd /d \`\"\$root\`\" && \`\"\$claude\`\" $preseed\", \$root, 'open', 1)"
```

After running, respond with one line only: `Terminal opened at <repo-name>.` or `Terminal opened at <repo-name> with \`$preseed\`.` Do not start a Monitor, do not write a signal file, do not read any files.
