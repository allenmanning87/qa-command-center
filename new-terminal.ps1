# Opens a fresh Claude Code CLI terminal at the specified repo or the project root.
# Optional -Repo parameter targets a sibling repo; optional -Command parameter pre-seeds a slash command.
#
#   Usage: .\new-terminal.ps1                               (ACC root, blank session)
#   Usage: .\new-terminal.ps1 -Command /design              (ACC root, /design pre-seeded)
#   Usage: .\new-terminal.ps1 -Repo blt-e2e                 (blt-e2e root, blank session)
#   Usage: .\new-terminal.ps1 -Repo blt-e2e -Command /design (blt-e2e root, /design pre-seeded)
#
# Uses Shell.Application COM object to spawn a visible desktop window even from
# within VSCode's non-interactive subprocess context.
#
# REPOS_PARENT is read from .env in the repo root. Update it there if your repos
# live somewhere other than C:\Git-Repositories.

param(
    [string]$Repo = "",
    [string]$Command = ""
)

$reposParent = "C:\Git-Repositories"
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    $match = Select-String -Path $envFile -Pattern "^REPOS_PARENT=(.+)" | Select-Object -First 1
    if ($match) { $reposParent = $match.Matches[0].Groups[1].Value.Trim() }
}

$root = if ($Repo -eq "") { $PSScriptRoot } else { Join-Path $reposParent $Repo }
$claude = "$env:APPDATA\npm\claude"
$sh = New-Object -ComObject Shell.Application

if ($Command -eq "") {
    $sh.ShellExecute("cmd.exe", "/k cd /d `"$root`" && `"$claude`"", $root, "open", 1)
} else {
    $sh.ShellExecute("cmd.exe", "/k cd /d `"$root`" && `"$claude`" $Command", $root, "open", 1)
}
