# tmuxlab

Your tmux sessions from a browser or the Android app: start shells, Claude, Codex, tests or dev servers, close the page, and they keep running inside tmux. One web app in `public/` is served by the server and also ships, unchanged, inside the Android APK (Capacitor, the same setup as home_builder).

## Run it

    npm install
    npm start                      # prints links with your token, e.g. http://192.168.1.6:7681/#token=…

Open a printed link on any device. The token lives in `~/.config/tmuxlab/token`; delete the file and restart to rotate it.

Keep it running at boot:

    scripts/install-service.sh     # systemd user service; restarting it never kills your tmux sessions

### From your phone, anywhere

Use Tailscale (already on this machine). Either open `http://<tailscale-ip>:7681/#token=…` from the startup links, or get HTTPS, which also lets Chrome install the web app:

    tailscale serve --bg 7681      # then https://<machine>.<tailnet>.ts.net/#token=…

Don't expose the port to the public internet. The token gives full shell access as your user.

### Android app

    npm run build:android          # signed APK in dist/tmuxlab.apk (Docker, no local Java/SDK)

Install it, then paste a startup link (or address and token) on the connect screen. `android/release.jks` and `KEYSTORE_PASSWORD` in `.env` sign every update. Keep copies somewhere other than this machine.

## Using it

- **Wall**: every session shows a live tail of its active window. Green light means a program (claude, codex, a test run) is running; grey means an idle shell. Ctrl+K jumps to any session or window; N starts a new one.
- **New session**: pick a launcher and a folder (browse, or a recent one). The session is named after the folder.
- **Start / Stop**: Stop sends Ctrl+C twice (what Claude and Codex need to exit). Start reruns the window's launcher command. Restart does both. The session and its shell stay alive either way.
- **Terminal**: tabs are tmux windows (double-click to rename), + adds a window from a launcher. On phones, the key bar has Esc, Tab, Shift+Tab (Claude mode switch), sticky Ctrl/Alt, arrows (hold to repeat), ^C, ^B (tmux prefix) and symbols. The compose box is the reliable way to type on Android keyboards; multi-line text goes in as one paste.
- **History**: swipe down or scroll the wheel to page back through tmux history. It exits when you scroll to the bottom or tap Exit.
- **Launchers**: Settings edits them as JSON (`id`, `label`, `cmd`, optional `icon`), saved to `~/.config/tmuxlab/presets.json`. Add your CI or build commands there.

Your existing tmux sessions show up too. Sessions whose names contain characters other than letters, digits, `-`, `_` and `.` are listed but can't be controlled. Rename them first.

## Develop

    npm test                       # end-to-end against real tmux on a private socket; never touches your sessions

Settings: `PORT` (7681), `HOST` (0.0.0.0), `TMUXLAB_HOME` (~/.config/tmuxlab), `TMUXLAB_TOKEN`, `TMUXLAB_SOCKET` (tmux -L name).

Layout: `server.js` (REST + WebSocket, one `tmux attach` pty per viewer), `public/` (the whole UI, no build step), `scripts/` (vendor copy, icons, APK build, service install), `android/` (Capacitor shell).
