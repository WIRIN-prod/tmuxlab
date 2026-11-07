# tmuxlab

Your tmux sessions from a browser or the Android app: start shells, Claude, Codex, tests or dev servers, close the page, and they keep running inside tmux. One web app in `public/` is served by the server and also ships, unchanged, inside the Android APK (Capacitor, the same setup as home_builder).

## Run it

    npm install
    npm start                      # prints links with your token, e.g. http://192.168.1.6:7681/#token=…

Open a printed link on any device. That server token only signs devices in: each device then gets its own key, listed in Settings › Devices, where you can remove one without signing out the rest. The server token lives in `~/.config/tmuxlab/token`; Settings › Devices › New server token replaces it (signed-in devices stay signed in).

Keep it running at boot:

    scripts/install-service.sh     # systemd user service; restarting it never kills your tmux sessions

### From your phone, anywhere

Use Tailscale (already on this machine). Either open `http://<tailscale-ip>:7681/#token=…` from the startup links, or get HTTPS, which also lets Chrome install the web app:

    tailscale serve --bg 7681      # then https://<machine>.<tailnet>.ts.net/#token=…

Don't expose the port to the public internet. The token gives full shell access as your user.

### Android app

    npm run build:android          # signed APK in dist/tmuxlab.apk (Docker, no local Java/SDK)

Install it, then paste a startup link (or address and token) on the connect screen. After that the app updates itself from the machine: `npm run build:android` leaves the new APK in `dist/`, and the next time the app connects it offers **Update** (Android asks once to allow installs from your browser, then before each install). `android/release.jks` and `KEYSTORE_PASSWORD` in `.env` sign every update. Keep copies somewhere other than this machine.

## Using it

- **Sessions list**: one row per session with a status tile, what it runs, its repo, branch, worktree and folder, and its CPU and memory use. The grid button switches to cards with a live tail of each session's active window. The search box filters by session, folder, repo or branch, and the filter tabs show counts. The sidebar (a drawer behind ☰ on phones) lists your saved machines with how many sessions each runs, plus Schedules and Settings; the machine's CPU, RAM and disk sit at its foot. On phones the round + button starts a new session. Cyan means a program (claude, codex, a test run) is running, grey means an idle shell, and amber means an agent is asking you something. If the machine stops answering, a banner says so and keeps the last known state on screen. Ctrl+K jumps to any session or window; N starts a new one.
- **Where each session runs**: every card and the terminal show the program running (claude, codex, …), the git repository, the worktree if it isn't the main checkout, and the folder. Ctrl+K searches these too, so typing a repo or worktree name finds its sessions. Sessions started without a name are named after their folder (`tmuxlab`, `tmuxlab-2`) instead of a number.
- **Approve prompts**: when Claude Code, Codex or a similar agent shows an arrow-key menu ("Do you want to proceed? ❯ 1. Yes"), the card and the terminal show its options as buttons. Tapping one answers it. "Needs you" filters to sessions that are waiting.
- **Phone alerts**: Settings › Phone alerts. Tap New topic, subscribe to that topic in the [ntfy](https://ntfy.sh) app, and the server pushes when an agent asks a question, goes quiet after working, or a launched command exits. This works with tmuxlab closed. It can also warn when the machine's disk or memory is over 90% full or its CPU has been busy for 5 minutes (once per episode). ntfy.sh topics are public to anyone who knows the name, so keep the random one, or point it at your own ntfy server. Question alerts carry the agent's options as buttons (up to three): tapping one answers it without opening tmuxlab. Each button is a one-time link that expires after 15 minutes and can only pick an option of that question; it goes to the address of the device you last saved alert settings from, so it works while the phone can reach the machine.
- **Projects**: folders for sessions. **New project** (folder icon) adds one with an optional default folder; each project is a collapsible section on the wall with its own **+ Session** button. Move a session with ⋯ › Move to project, or drag its card onto a project heading on desktop. The project is stored on the tmux session (`@tl_project`), so every device sees the same grouping and it survives renames. Deleting a project keeps its sessions running under No project.
- **New session**: pick a launcher or a stack and a folder. In a git repo, "Work on a new branch in its own folder" creates a git worktree (`<repo>.worktrees/<branch>`), so several agents can work on the same repo without colliding.
- **Stacks**: a stack opens several windows and splits at once, e.g. dev server + tests + claude, or claude and codex side by side. Edit them in Settings › Stacks.
- **Snippets**: in the terminal, Snippets (toolbar on desktop, first extra key on phones) runs a saved command in the focused pane. Add, rename and delete them in Settings > Snippets; every device on that machine shares the list. Recent message-box sends are listed under them. Write `{{name}}` in a snippet for a value it asks for each time, e.g. `git checkout -b {{branch}}`.
- **Changes & PR**: the ⎇ branch button in the terminal (or ⋯ › Changes on a card) lists changed files with diffs, then commits, pushes and opens a pull request with `gh`. In a worktree it can also remove the worktree.
- **Start / Stop**: Stop sends Ctrl+C twice (what Claude and Codex need to exit). Start reruns the pane's launcher command. Restart does both. The session and its shell stay alive either way.
- **Session tabs**: sessions you open stay as tabs along the top of the terminal, with a dot for running (cyan) or waiting for you (amber) and a mark when there's output you haven't seen. Tap to switch, + to open another, ✕ to close the tab (the session keeps running). Right-click or long-press a tab to rename the session, open it beside the current one, or close other tabs. On a keyboard, Alt+1…9 jumps to a tab and Alt+[ / Alt+] steps through them.
- **Claude Code and Codex**: Run… (or + › Claude Code… / Codex…, or ⋯ on an idle session) opens a launcher: start a new conversation, continue the latest, or pick an earlier conversation from that folder by its title; choose the permission mode and model; for Claude, turn on Remote Control (`--remote-control`) or start a copy of an old conversation (`--fork-session`); for Codex, web search. It shows the exact command before running it. While an agent runs, the Claude / Codex button in the terminal sends its controls: interrupt, switch mode (Shift+Tab), rewind, compact, context, model, resume, remote control, status and clear for Claude; interrupt, model, permissions, diff, review, compact, resume, status and new for Codex. The sessions list shows each agent's latest step and its mode (plan, accept edits, auto…).
- **Dev server preview**: when a program in a session listens on a port (a dev server on 5173, say), a :5173 button appears in the terminal and ⋯ › Open :5173 on its row. It opens through tmuxlab, so it works from a phone even if the server only listens on localhost. Each forwarded port gets its own key, set as a cookie on first visit; the forward closes when the port does.
- **Terminal**: tabs are tmux windows. A dot on a tab means output you haven't seen. Double-click a tab to rename it; right-click or long-press it to move or close it, or open it beside the current one. Panes splits the window right or down, zooms, cycles the layout, or types into all panes at once; chips switch between panes. Find searches the last 3000 lines and copies them. Pinch or A−/A+ changes the text size.
- **Split view** (tablets and desktop): ⊞ shows up to four windows side by side, from any session. Each one is its own live terminal.
- **Phones**: the key bar has Esc, Tab, Shift+Tab (Claude mode switch), sticky Ctrl/Alt, arrows (hold to repeat), Paste, ^C, ^B (tmux prefix) and symbols. Tap the terminal to type. Dictate (browsers with speech recognition, e.g. Chrome) types what you say into the terminal; in the Android app, use the keyboard's mic. Attach uploads files or photos into `.tmuxlab-uploads/` in the pane's folder (git-ignored) and types the path, ready for the agent.
- **Scrolling back**: swipe down (with momentum) or scroll the wheel. In a shell this pages through tmux history and exits when you reach the bottom or tap Exit. Full-screen programs that keep their own history, such as Claude Code and Codex, get the swipe as mouse-wheel scrolling, so you read their transcript the way you would on a desktop.
- **Back button**: on Android, Back closes the open dialog or menu first, then leaves the terminal. Esc does the same on desktop, and tapping outside a dialog closes it.
- **Schedules**: the clock button runs a launcher or command on a schedule (every hour, daily, weekdays, weekly or a cron expression) in a session, e.g. nightly tests or a morning review by Claude. Run now tries it immediately.
- **Multiple machines**: tap the machine name to switch between machines, add one, or see which are online. Each machine runs its own tmuxlab server.
- **Restore after a reboot**: tmuxlab saves the layout of every session every 30 seconds. After the machine restarts, the sessions list offers to bring them back: same names, windows, splits and folders, with launched commands started again and Claude Code / Codex continuing their last conversation (`claude --continue`, `codex resume --last`). Programs you typed yourself come back as a shell in the right folder.
- **Send to several**: menu › Send to several types one message into many sessions at once (the agent's pane, if one runs there). Agent sessions are ticked by default; multi-line text goes in as one paste.
- **Repos**: menu › Repos lists every git repo your sessions work in, with each worktree's branch, uncommitted files, ahead/behind and last commit, and which sessions are there. New task… makes a branch in its own worktree folder, opens a session there and the Claude/Codex launcher.
- **Search output**: menu › Search output searches what every session printed (the last 5,000 lines of each pane), including sessions that ended or were lost in a reboot. The output is saved every minute to `~/.config/tmuxlab/logs/` (owner-only, kept 7 days), so it holds whatever your terminals showed.
- **Watch links**: ⋯ › Share a watch link on a session makes a link (1 hour to 1 week) that shows that one session live, read-only, without your sign-in. It can't type, see other sessions or change the window size. Remove it early in Settings › Devices.
- **Pairing**: Settings › Pair a phone shows a QR code with a new device key (treat it like a password; it appears in Settings › Devices once used). On the server, `npm run pair` prints the same QR in the terminal, using the Tailscale address when there is one. Scan it with the phone's camera, or with Scan QR code on the app's connect screen where the device supports it.
- **Launchers**: Settings › Launchers edits them as JSON (`id`, `label`, `cmd`, optional `icon`).

Config lives in `~/.config/tmuxlab/` (`presets.json`, `projects.json`, `stacks.json`, `schedules.json`, `settings.json`, `token`, `devices.json` with hashed device keys, `snapshot.json` for restore, and `logs/`).

Your existing tmux sessions show up too. Sessions whose names contain characters other than letters, digits, `-`, `_` and `.` are listed but can't be controlled. Rename them first.

## Develop

    npm test                       # end-to-end against real tmux on a private socket; never touches your sessions

Settings: `PORT` (7681), `HOST` (0.0.0.0), `TMUXLAB_HOME` (~/.config/tmuxlab), `TMUXLAB_TOKEN`, `TMUXLAB_SOCKET` (tmux -L name).

Layout: `server.js` (REST + WebSocket, one `tmux attach` pty per viewer through a grouped "view" session, so each device keeps its own window), `lib/` (tmux, git, cron, stats, alert watcher), `public/` (the whole UI as ES modules in `public/js/`, no build step), `scripts/` (vendor copy, icons, APK build, service install), `android/` (Capacitor shell).
