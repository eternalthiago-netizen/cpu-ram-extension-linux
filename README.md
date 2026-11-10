# CPU & RAM Usage for GNOME

GNOME Shell extension that shows your CPU and RAM usage, CPU/GPU temperatures and disk activity in the top bar (CPU, RAM, GPU and disk icons, e.g. `12% 57°  41%  50°  3% R 4.8M W 1.1M`).

- Compact icons instead of text labels; the icons follow the panel theme.
- Choose what the top bar shows from the menu (**Show in top bar**): CPU usage, CPU temperature, RAM usage, GPU temperature, disk activity, disk read/write and disk space. The choice is saved in `~/.config/cpu-ram-usage.json`.
- **Show hidden items when high** (on by default): an item turned off in the top bar still appears while its value is at a warning level (orange or red), and stays 30 seconds after it drops so short spikes don't flicker. For example, keep disk space hidden and it shows up as `85% full` when the disk fills up.
- Disk activity is the % of time the disk was busy (like `iostat` %util); read/write is in bytes per second (`K` = KiB/s, `M` = MiB/s).
- Usage and disk space turn orange from 80% and red from 90%; temperatures turn orange from 85 °C and red from 95 °C.
- The menu shows CPU, RAM (used and total in GiB), GPU temperature, disk activity with read/write in MB/s, space used on `/` (same % as `df`) and SSD temperature.
- Refreshes every 2 seconds.

## How it works

The extension reads `/proc/stat` (CPU) and `/proc/meminfo` (RAM) directly. RAM "used" is total minus `MemAvailable`, the same idea as `free`, so cache and buffers are not counted as used. Disk activity comes from `/proc/diskstats` (physical disks only; loop, zram and device-mapper are skipped). Temperatures come from `/sys/class/hwmon` (`coretemp`/`k10temp` for the CPU, `amdgpu`/`nouveau` for the GPU, `nvme` for the SSD).

The proprietary NVIDIA driver has no hwmon sensor, so the GPU temperature comes from `nvidia-smi`, run only while the GPU temperature is shown or the menu is open, and every 10 seconds to catch a high temperature when it is hidden. When the GPU is asleep (hybrid graphics laptops), it shows `off` instead of waking it up. Sensors the machine lacks are hidden.

## Install

```bash
./build-deb.sh            # builds dist/gnome-cpu-ram-usage_1.4.0_all.deb
sudo apt install ./dist/gnome-cpu-ram-usage_1.4.0_all.deb
gnome-extensions enable cpu-ram-usage@local
```

Restart GNOME Shell (X11: Alt+F2, `r`, Enter; Wayland: log out and back in).

Without the package, copy the `cpu-ram-usage@local` folder to `~/.local/share/gnome-shell/extensions/`.

For another version: `./build-deb.sh 1.5.0`.

## Requirements

- GNOME Shell 45 to 49

## License

MIT
