# Laptop setup (one time)

Everything runs as systemd **user** units, so nothing here needs root except the lid settings.

```bash
loginctl enable-linger $USER                  # user units run without a login session and after a reboot
mkdir -p ~/.config/systemd/user && cp infra/systemd/* ~/.config/systemd/user/
systemctl --user daemon-reload

# 1. Database: the compose db has `restart: unless-stopped`; something must start it at boot.
docker compose up -d db                       # from the repo root
systemctl --user enable podman-restart.service   # rootless podman (this laptop); with Docker, the daemon does it
# An existing container keeps the policy it was created with: recreate it (`docker compose up -d
# --force-recreate db`; the pgdata volume stays) or `podman update --restart=unless-stopped teenpehr-db`.

# 2. Web app: build the standalone server, then run it as a unit that starts at boot.
cd web && npm run build && cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/ && cd ..
systemctl --user enable --now teenpehr-web.service

# 3. Claude: the worker runs every model call through the Claude Code CLI signed in as this user
#    (the Claude subscription, never an API key). Either sign in once interactively...
claude                                        # then /login, then /exit (credentials land in ~/.claude)
#    ...or, steadier for a timer, make a long-lived token and put it in worker/.env:
claude setup-token                            # prints a token: CLAUDE_CODE_OAUTH_TOKEN=... in worker/.env
cd worker && uv sync && uv run teenpehr health && cd ..   # web API reachable and "logged_in": true; spends nothing

# 4. Worker timers and the SOCKS proxy to Germany.
systemctl --user enable --now germany-proxy.service x-collector.timer news-worker.timer
systemctl --user list-timers
```

Claude access. The worker uses the owner's Claude subscription through Claude Code on this laptop
(later a dedicated laptop signed in the same way), not the Anthropic API: no `ANTHROPIC_API_KEY`
anywhere. The units drop one if `worker/.env` still has it, and the worker blanks it for the CLI too,
so a stray key can never move the bill to the API. Usage counts against the same account's Claude Code
limits as interactive sessions on it; the dollar figures in run logs and the admin are API-equivalent
(the CLI prices the tokens at API list prices) and `DAILY_BUDGET_USD` caps them per day. A token from
`claude setup-token` is long-lived and independent of the interactive login (signing out of `claude`
does not stop the timer). When the CLI is signed out, the next due slot fails once (an ntfy alert) and
runs as soon as `uv run teenpehr health` shows `"logged_in": true` again.

Rebuild after every web change (step 2's build line), then `systemctl --user restart teenpehr-web`.
The worker units also pull `teenpehr-web.service` in (`Wants=`) and start only once it answers, so
a run after a reboot finds the API up even if step 2's `enable` was skipped; step 2 still matters
for readers.

Lid and sleep: `/etc/systemd/logind.conf.d/50-lid.conf` with `HandleLidSwitch=ignore`,
`HandleLidSwitchExternalPower=ignore`, `HandleLidSwitchDocked=ignore`, then
`sudo systemctl kill -s HUP systemd-logind`; and
`gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'`.

## Edition times and catch-up

The edition times are set in the admin (Settings), not in systemd. `news-worker.timer` fires every
10 minutes and runs `teenpehr edition --scheduled`, which reads those times and runs the latest slot
that is due, once: a firing that finds that slot already started does nothing (no run row, no
Claude). Each edition therefore starts within 10 minutes of its time, and a change in the admin
needs nothing here. The slots the timer started are kept in `worker/out/state/schedule.json`; a
failed or empty slot is not retried on its own (rerun it with `uv run teenpehr edition --date … --slot …`).

`Persistent=true` fires once when the laptop wakes, which runs the latest slot that came due while it
slept (as a backfill, without notifications, when it is more than 2 h late). systemd never starts
`news-worker.service` while a run is still active, so firings during a long run are dropped; the
worker covers this itself: after each edition it re-resolves the slot and runs any slot that has
fallen due and is not published yet (at most two extra per run). A slot that is already published,
or held in review, is skipped without calling Claude and without an alert; release a held edition in
the admin to let the worker redo it.

If the web app does not answer when a slot falls due, that firing fails (one alert per slot), and
later firings keep trying quietly until it is back; the slot then runs late, as above.

## Alerts and logs

Failures of `news-worker`, `x-collector` and `teenpehr-web` (five failed starts within ten
minutes, after which it stops restarting until the next worker run pulls it in) post the last 40
log lines to ntfy
(`news-alert@.service`, topic `NTFY_TOPIC` in `worker/.env`; nothing is sent while it is empty).
Edition runs skipped for the daily budget, and runs that collected nothing, exit non-zero, so they
alert too (alongside the worker's own ntfy note); timer firings with no slot due exit 0; so does an X collector run in which no configured List returned a post (the sign that X
closed the endpoint). The collector also posts its own ntfy note when a single List looks stale.

Logs: `journalctl --user -u news-worker -f` (or `x-collector`, `teenpehr-web`).

Edition snapshots (the JSON written at publish) go to `~/.local/share/teenpehr/snapshots`, set by
`EDITION_SNAPSHOT_DIR` in `teenpehr-web.service`; never inside `web/.next/`, which each build wipes.
