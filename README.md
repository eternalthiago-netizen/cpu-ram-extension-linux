# CPU & RAM Usage for GNOME

GNOME Shell extension that shows your CPU and RAM usage in the top bar (`CPU 12% · RAM 41%`).

- Each value turns orange from 80% and red from 90%.
- The menu shows RAM used and total in GiB.
- Refreshes every 2 seconds.

## How it works

The extension reads `/proc/stat` (CPU) and `/proc/meminfo` (RAM) directly. RAM "used" is total minus `MemAvailable`, the same idea as `free`, so cache and buffers are not counted as used. There is no helper process and no extra dependency.

## Install

```bash
./build-deb.sh            # builds dist/gnome-cpu-ram-usage_1.0.0_all.deb
sudo apt install ./dist/gnome-cpu-ram-usage_1.0.0_all.deb
gnome-extensions enable cpu-ram-usage@local
```

Restart GNOME Shell (X11: Alt+F2, `r`, Enter; Wayland: log out and back in).

Without the package, copy the `cpu-ram-usage@local` folder to `~/.local/share/gnome-shell/extensions/`.

For another version: `./build-deb.sh 1.1.0`.

## Requirements

- GNOME Shell 45 to 49

## License

MIT
