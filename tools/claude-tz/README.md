# Claude Code timezone (CLI)

The **notme browser extension** spoofs the timezone your **browser** reports
(claude.ai web, fingerprint tests, etc.). It does **nothing** for **Claude Code**
in the terminal — that's a Node process that reports the **OS timezone** (via the
`TZ` environment variable) in its system prompt.

These scripts add a small `claude` wrapper to your shell profile so that every
`claude` launch runs with `TZ` set to a US zone, while the rest of your shell
keeps its real timezone.

> **Two separate channels — don't mix them up:**
> | You use | Timezone comes from | Fix with |
> | --- | --- | --- |
> | claude.ai website / fingerprint tests | the **browser** | the **notme extension** (*Force timezone*) |
> | **Claude Code in the terminal** | the **OS `TZ`** | **these scripts** |

## Install

### macOS / Linux / WSL (zsh, bash, fish)

```bash
cd tools/claude-tz
bash install.sh                    # default America/Los_Angeles
bash install.sh America/New_York   # or pick another US zone
```

Then open a **new terminal** (or `source ~/.zshrc`). Undo with `bash uninstall.sh`.

### Windows (PowerShell)

```powershell
cd tools\claude-tz
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 America/New_York
```

Then open a **new PowerShell** (or `. $PROFILE`).

## Or add it by hand

**zsh** — `~/.zshrc`, **bash** — `~/.bashrc`:

```bash
export NOTME_CLAUDE_TZ="America/Los_Angeles"
claude() { TZ="$NOTME_CLAUDE_TZ" command claude "$@"; }
```

**fish** — `~/.config/fish/config.fish`:

```fish
set -gx NOTME_CLAUDE_TZ "America/Los_Angeles"
function claude
    env TZ=$NOTME_CLAUDE_TZ command claude $argv
end
```

**PowerShell** — `$PROFILE`:

```powershell
$env:NOTME_CLAUDE_TZ = "America/Los_Angeles"
function claude {
    $exe = (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    $prev = $env:TZ
    $env:TZ = $env:NOTME_CLAUDE_TZ
    try { & $exe @args } finally { $env:TZ = $prev }
}
```

**Windows cmd.exe** (per-launch only — cmd has no clean profile hook):

```cmd
set TZ=America/Los_Angeles && claude
```

## Common US timezones

| Region | IANA |
| --- | --- |
| Pacific | `America/Los_Angeles` |
| Mountain | `America/Denver` |
| Central | `America/Chicago` |
| Eastern | `America/New_York` |

## Verify

```bash
TZ=America/Los_Angeles node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"
# -> America/Los_Angeles
```

`TZ` must be set **before** the process starts (the wrapper does this), and needs
a reasonably recent Node/Claude Code (full-ICU, which is the default).

## The honest caveat

This changes the timezone Claude Code **reports**. It does **not** change your
**exit IP** — the same page notes Claude Code also reads the relay hostname, and
your account's real network path still resolves to wherever your proxy exits. If
that's China, an IP-side check still sees China. The only real fix for the IP is
a proxy/relay that exits where you want to appear. `TZ` closes the *timezone*
signal; it is not a full disguise.
