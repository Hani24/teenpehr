# Laptop setup (one time)

```bash
loginctl enable-linger $USER
mkdir -p ~/.config/systemd/user && cp infra/systemd/* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now germany-proxy.service x-collector.timer news-worker.timer
systemctl --user list-timers
```

Lid and sleep: `/etc/systemd/logind.conf.d/50-lid.conf` with `HandleLidSwitch=ignore`,
`HandleLidSwitchExternalPower=ignore`, `HandleLidSwitchDocked=ignore`, then
`sudo systemctl kill -s HUP systemd-logind`; and
`gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'`.

Logs: `journalctl --user -u news-worker -f`. Failures post the last 40 lines to ntfy.
