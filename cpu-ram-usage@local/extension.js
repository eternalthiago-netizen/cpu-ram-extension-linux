import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const POLL_SECONDS = 2;

function readText(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes);
}

// Aggregate CPU times from the first line of /proc/stat
function readCpuTimes() {
    const line = readText('/proc/stat').split('\n')[0];
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = v[3] + (v[4] ?? 0); // idle + iowait
    const total = v.slice(0, 8).reduce((a, b) => a + b, 0);
    return {idle, total};
}

// Memory actually in use: total - MemAvailable (same idea as `free`)
function readMemory() {
    const info = {};
    for (const line of readText('/proc/meminfo').split('\n')) {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if (m)
            info[m[1]] = Number(m[2]);
    }
    const total = info.MemTotal ?? 0;
    const used = total - (info.MemAvailable ?? 0);
    return {total, used};
}

function gib(kib) {
    return (kib / 1048576).toFixed(1);
}

// Physical disks only: loop, zram, device-mapper and RAID have no device/ link
function findDisks() {
    return listDir('/sys/block').filter(n =>
        !/^(loop|zram|ram)/.test(n) && GLib.file_test(`/sys/block/${n}/device`, GLib.FileTest.EXISTS));
}

// Per-disk counters from /proc/diskstats: busy time (ms) and bytes read/written
// (sectors there are always 512 bytes)
function readDiskStats(disks) {
    const stats = {};
    for (const line of readText('/proc/diskstats').split('\n')) {
        const f = line.trim().split(/\s+/);
        if (disks.includes(f[2]))
            stats[f[2]] = {read: Number(f[5]) * 512, written: Number(f[9]) * 512, busyMs: Number(f[12])};
    }
    return stats;
}

// Short rate for the top bar: 0, 512K, 3.4M, 120M
function rate(bytesPerSec) {
    if (bytesPerSec < 1024)
        return '0';
    if (bytesPerSec < 1048576)
        return `${Math.round(bytesPerSec / 1024)}K`;
    const mb = bytesPerSec / 1048576;
    return mb < 100 ? `${mb.toFixed(1)}M` : `${Math.round(mb)}M`;
}

// Space used on the root filesystem, like `df /`: the % leaves out the
// blocks reserved for root, so it is used / (used + available)
function rootSpace() {
    const info = Gio.File.new_for_path('/').query_filesystem_info(
        'filesystem::size,filesystem::used,filesystem::free', null);
    const size = info.get_attribute_uint64('filesystem::size');
    const used = info.get_attribute_uint64('filesystem::used');
    const avail = info.get_attribute_uint64('filesystem::free');
    return {size, used, pct: used + avail > 0 ? Math.round(100 * used / (used + avail)) : 0};
}

function readFirstLine(path) {
    try {
        return readText(path).trim();
    } catch {
        return null;
    }
}

function listDir(path) {
    const names = [];
    try {
        const dir = GLib.Dir.open(path, 0);
        let name;
        while ((name = dir.read_name()) !== null)
            names.push(name);
        dir.close();
    } catch {}
    return names.sort();
}

// hwmon drivers that report the CPU temperature, and the preferred sensor label
const CPU_SENSORS = {coretemp: /^Package id/, k10temp: /^(Tctl|Tdie)$/, zenpower: /^(Tctl|Tdie)$/};

// Path of a temp*_input file: the labelled sensor if there is one, else temp1
function hwmonInput(dir, preferred) {
    const inputs = listDir(dir).filter(n => /^temp\d+_input$/.test(n));
    const labelled = preferred && inputs.find(n =>
        preferred.test(readFirstLine(`${dir}/${n.replace('_input', '_label')}`) ?? ''));
    const pick = labelled ?? (inputs.includes('temp1_input') ? 'temp1_input' : inputs[0]);
    return pick ? `${dir}/${pick}` : null;
}

// hwmon drivers that report a GPU temperature (AMD, open-source NVIDIA)
const GPU_SENSORS = {amdgpu: /^edge$/, nouveau: null};

// The proprietary NVIDIA driver has no hwmon sensor: its temperature comes
// from nvidia-smi. Returns the PCI device dir, used to skip a sleeping GPU.
function findNvidiaGpu() {
    if (!GLib.find_program_in_path('nvidia-smi'))
        return null;
    for (const d of listDir('/sys/bus/pci/devices')) {
        const dir = `/sys/bus/pci/devices/${d}`;
        if (readFirstLine(`${dir}/vendor`) === '0x10de' &&
            readFirstLine(`${dir}/class`)?.startsWith('0x03'))
            return dir;
    }
    return null;
}

// Found once at startup; null when the machine exposes no such sensor
function findTempSensors() {
    let cpu = null, disk = null, gpu = null;
    for (const h of listDir('/sys/class/hwmon')) {
        const dir = `/sys/class/hwmon/${h}`;
        const name = readFirstLine(`${dir}/name`);
        if (!cpu && name in CPU_SENSORS)
            cpu = hwmonInput(dir, CPU_SENSORS[name]);
        else if (!disk && name === 'nvme')
            disk = hwmonInput(dir, /^Composite$/);
        else if (!gpu && name in GPU_SENSORS)
            gpu = hwmonInput(dir, GPU_SENSORS[name]);
    }
    const nvidia = gpu ? null : findNvidiaGpu();
    // Fallback: the kernel's package thermal zone
    for (const z of cpu ? [] : listDir('/sys/class/thermal')) {
        if (readFirstLine(`/sys/class/thermal/${z}/type`) === 'x86_pkg_temp') {
            cpu = `/sys/class/thermal/${z}/temp`;
            break;
        }
    }
    return {cpu, disk, gpu, nvidia};
}

// Degrees Celsius, or null if the sensor cannot be read
function readTemp(path) {
    const milli = path ? Number(readFirstLine(path)) : NaN;
    return Number.isFinite(milli) && milli > 0 ? Math.round(milli / 1000) : null;
}

// NVIDIA temperature via nvidia-smi: a number, 'off' when the GPU is asleep
// (querying it would wake it up and drain the battery), or null on failure
function readNvidiaTemp(pciDir) {
    if (readFirstLine(`${pciDir}/power/runtime_status`) === 'suspended')
        return Promise.resolve('off');
    return new Promise(resolve => {
        try {
            const proc = Gio.Subprocess.new(
                ['nvidia-smi', '--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const c = parseInt(p.communicate_utf8_finish(res)[1], 10);
                    resolve(Number.isFinite(c) ? c : null);
                } catch {
                    resolve(null);
                }
            });
        } catch {
            resolve(null);
        }
    });
}

function color(pct) {
    if (pct >= 90)
        return 'color: #ff6b6b;';
    if (pct >= 80)
        return 'color: #ffb347;';
    return '';
}

// Warning colors from mildest to worst
const SEVERITY = ['color: #ffb347;', 'color: #ff6b6b;'];

// Most laptop CPUs and GPUs throttle around 100 °C
function tempColor(c) {
    if (c >= 95)
        return 'color: #ff6b6b;';
    if (c >= 85)
        return 'color: #ffb347;';
    return '';
}

// What the top bar shows; chosen from the menu and kept across restarts
const SETTINGS_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'cpu-ram-usage.json']);
const DEFAULTS = {
    cpu: true, cpuTemp: true, ram: true, gpuTemp: false,
    diskBusy: true, diskRate: true, diskSpace: false, autoShow: true,
};
const BAR_OPTIONS = [
    ['cpu', 'CPU usage'], ['cpuTemp', 'CPU temperature'],
    ['ram', 'RAM usage'], ['gpuTemp', 'GPU temperature'],
    ['diskBusy', 'Disk activity'], ['diskRate', 'Disk read/write'],
    ['diskSpace', 'Disk space'],
];

// With autoShow, a hidden item appears while its value is at a warning level
// (the orange threshold) and stays this long after it drops, so spikes don't flicker
const ALERT_HOLD_SECONDS = 30;
// Hidden GPU: checked this often for alerts only (nvidia-smi is a process)
const GPU_ALERT_POLL_SECONDS = 10;

function loadSettings() {
    try {
        return {...DEFAULTS, ...JSON.parse(readText(SETTINGS_FILE))};
    } catch {
        return {...DEFAULTS};
    }
}

function saveSettings(settings) {
    try {
        GLib.file_set_contents(SETTINGS_FILE, JSON.stringify(settings));
    } catch (e) {
        logError(e);
    }
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(path) {
        super._init(0.0, 'CPU & RAM Usage');

        const icon = name => new St.Icon({
            gicon: Gio.icon_new_for_string(`${path}/icons/${name}-symbolic.svg`),
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const label = text => {
            const l = new St.Label({text, y_align: Clutter.ActorAlign.CENTER});
            l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            return l;
        };

        this._sensors = findTempSensors();
        this._disks = findDisks();
        this._settings = loadSettings();

        // One group per icon: CPU (usage + temperature), RAM, GPU, disk
        this._cpuIcon = icon('cpu');
        this._cpu = label('…');
        this._cpuTemp = label('');
        this._ramIcon = icon('ram');
        this._ram = label('…');
        this._gpuIcon = icon('gpu');
        this._gpuTemp = label('…');
        this._diskIcon = icon('disk');
        this._diskBusy = label('…');
        this._diskRate = label('');
        this._diskSpace = label('');
        this._alertUntil = {};
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._groups = [
            [this._cpuIcon, this._cpu, this._cpuTemp],
            [this._ramIcon, this._ram],
            [this._gpuIcon, this._gpuTemp],
            [this._diskIcon, this._diskBusy, this._diskRate, this._diskSpace],
        ].map(children => {
            const group = new St.BoxLayout();
            for (const c of children)
                group.add_child(c);
            box.add_child(group);
            return group;
        });
        this.add_child(box);

        this._cpuItem = new PopupMenu.PopupMenuItem('CPU', {reactive: false});
        this._ramItem = new PopupMenu.PopupMenuItem('RAM', {reactive: false});
        this._gpuItem = new PopupMenu.PopupMenuItem('GPU', {reactive: false});
        this._diskItem = new PopupMenu.PopupMenuItem('SSD', {reactive: false});
        this._ioItem = new PopupMenu.PopupMenuItem('Disk', {reactive: false});
        this._spaceItem = new PopupMenu.PopupMenuItem('Space', {reactive: false});
        this._gpuItem.visible = this._hasGpu();
        this._diskItem.visible = this._sensors.disk !== null;
        this._ioItem.visible = this._disks.length > 0;
        for (const item of [this._cpuItem, this._ramItem, this._gpuItem, this._ioItem,
            this._spaceItem, this._diskItem])
            this.menu.addMenuItem(item);

        // Switches for what the top bar shows (only for what this machine has)
        const bar = new PopupMenu.PopupSubMenuMenuItem('Show in top bar');
        for (const [key, text] of BAR_OPTIONS) {
            if (!this._available(key))
                continue;
            const sw = new PopupMenu.PopupSwitchMenuItem(text, this._settings[key]);
            sw.connect('toggled', (_item, state) => {
                this._settings[key] = state;
                saveSettings(this._settings);
                this._layout();
                this._update();
            });
            bar.menu.addMenuItem(sw);
        }
        bar.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const auto = new PopupMenu.PopupSwitchMenuItem('Show hidden items when high', this._settings.autoShow);
        auto.connect('toggled', (_item, state) => {
            this._settings.autoShow = state;
            saveSettings(this._settings);
            this._layout();
            this._update();
        });
        bar.menu.addMenuItem(auto);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(bar);

        // Refresh at once on open, so the GPU line is current
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._update();
        });

        this._layout();
        this._prev = readCpuTimes();
        this._diskPrev = readDiskStats(this._disks);
        this._update();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _hasGpu() {
        return this._sensors.gpu !== null || this._sensors.nvidia !== null;
    }

    _available(key) {
        if (key === 'cpuTemp')
            return this._sensors.cpu !== null;
        if (key === 'gpuTemp')
            return this._hasGpu();
        if (key === 'diskBusy' || key === 'diskRate')
            return this._disks.length > 0;
        return true;
    }

    // Shown in the bar: chosen in the menu, or (with autoShow) recently at a warning level
    _show(key) {
        if (!this._available(key))
            return false;
        return this._settings[key] ||
            (this._settings.autoShow && (this._alertUntil[key] ?? 0) > GLib.get_monotonic_time());
    }

    // A value is at a warning level when it gets a color
    _markAlerts(styles) {
        const until = GLib.get_monotonic_time() + ALERT_HOLD_SECONDS * 1e6;
        for (const [key, style] of Object.entries(styles)) {
            if (style)
                this._alertUntil[key] = until;
        }
    }

    // Shows only the chosen (or alerting) values; keeps the CPU icon if nothing
    // is shown, so there is still something to click
    _layout() {
        const s = key => this._show(key);
        this._cpu.visible = s('cpu');
        this._cpuTemp.visible = s('cpuTemp');
        this._ram.visible = this._ramIcon.visible = s('ram');
        this._gpuTemp.visible = this._gpuIcon.visible = s('gpuTemp');
        this._diskBusy.visible = s('diskBusy');
        this._diskRate.visible = s('diskRate');
        this._diskSpace.visible = s('diskSpace');
        const shown = [s('cpu') || s('cpuTemp'), s('ram'), s('gpuTemp'),
            s('diskBusy') || s('diskRate') || s('diskSpace')];
        if (!shown.includes(true))
            shown[0] = true;
        let first = true;
        this._groups.forEach((group, i) => {
            group.visible = shown[i];
            group.style = shown[i] && !first ? 'margin-left: 10px;' : '';
            if (shown[i])
                first = false;
        });
        this._cpuIcon.visible = true;
    }

    async _readGpuTemp() {
        if (this._sensors.gpu)
            return readTemp(this._sensors.gpu);
        return this._sensors.nvidia ? await readNvidiaTemp(this._sensors.nvidia) : null;
    }

    async _update() {
        try {
            // Extra refreshes (menu opened, switch toggled) reuse the last sample:
            // a new one over a few milliseconds would read as 0% or 100%
            const now = GLib.get_monotonic_time();
            if (this._cpuPct === undefined || now - this._sampledAt >= 1e6) {
                const cur = readCpuTimes();
                const dTotal = cur.total - this._prev.total;
                const dIdle = cur.idle - this._prev.idle;
                this._prev = cur;
                this._cpuPct = dTotal > 0 ? Math.round(100 * (1 - dIdle / dTotal)) : 0;

                // Disk: busy % of the busiest disk (like iostat %util), bytes/s summed
                const secs = (now - (this._sampledAt ?? now - POLL_SECONDS * 1e6)) / 1e6;
                const disk = readDiskStats(this._disks);
                let busy = 0, read = 0, written = 0;
                for (const [name, d] of Object.entries(disk)) {
                    const p = this._diskPrev[name] ?? d;
                    busy = Math.max(busy, (d.busyMs - p.busyMs) / (secs * 10));
                    read += d.read - p.read;
                    written += d.written - p.written;
                }
                this._diskPrev = disk;
                this._io = {busy: Math.min(100, Math.round(busy)), read: read / secs, written: written / secs};
                this._sampledAt = now;
            }

            const mem = readMemory();
            let space = null;
            try {
                space = rootSpace();
            } catch {}
            const v = {
                cpu: this._cpuPct,
                temp: readTemp(this._sensors.cpu),
                mem,
                ram: mem.total > 0 ? Math.round(100 * mem.used / mem.total) : 0,
                io: this._io,
                space,
                diskTemp: readTemp(this._sensors.disk),
            };
            this._v = v;
            this._markAlerts({
                cpu: color(v.cpu),
                cpuTemp: v.temp !== null && tempColor(v.temp),
                ram: color(v.ram),
                diskBusy: color(v.io.busy),
                diskSpace: space && color(space.pct),
            });
            this._render();

            // GPU: when shown, when the menu is open, or now and then to catch an alert
            const forAlert = this._settings.autoShow &&
                now - (this._gpuReadAt ?? 0) >= GPU_ALERT_POLL_SECONDS * 1e6;
            if (this._hasGpu() && (this._show('gpuTemp') || this.menu.isOpen || forAlert) && !this._gpuBusy) {
                this._gpuBusy = true;
                this._gpuReadAt = now;
                const gpu = await this._readGpuTemp();
                this._gpuBusy = false;
                if (!this._timer)  // destroyed while waiting
                    return;
                this._gpu = gpu;
                this._markAlerts({gpuTemp: typeof gpu === 'number' && tempColor(gpu)});
                this._render();
            }
        } catch (e) {
            logError(e);
        }
    }

    _render() {
        const {cpu, temp, mem, ram, io, space, diskTemp} = this._v;
        this._layout();
        const gap = key => (this._show(key) ? ' ' : '');

        this._cpu.text = `${cpu}%`;
        this._cpuTemp.text = temp === null ? '' : `${gap('cpu')}${temp}°`;
        this._cpu.style = color(cpu);
        this._cpuTemp.style = temp === null ? '' : tempColor(temp);
        // The icon takes the worse of the two CPU colors shown
        const styles = [
            this._show('cpu') ? color(cpu) : '',
            this._show('cpuTemp') && temp !== null ? tempColor(temp) : '',
        ];
        this._cpuIcon.style = SEVERITY.findLast(c => styles.includes(c)) ?? '';
        this._cpuItem.label.text = temp === null ? `CPU: ${cpu}%` : `CPU: ${cpu}% · ${temp} °C`;

        this._ram.text = `${ram}%`;
        this._ram.style = this._ramIcon.style = color(ram);
        this._ramItem.label.text = `RAM: ${ram}% (${gib(mem.used)} of ${gib(mem.total)} GiB)`;

        const gpu = this._gpu;
        const off = gpu === 'off';
        this._gpuTemp.text = gpu === undefined ? '…' : off ? 'off' : `${gpu ?? '—'}°`;
        this._gpuTemp.style = this._gpuIcon.style = typeof gpu === 'number' ? tempColor(gpu) : '';
        this._gpuItem.label.text = off ? 'GPU: sleeping' : `GPU: ${gpu ?? '—'} °C`;

        this._diskBusy.text = `${io.busy}%`;
        this._diskBusy.style = color(io.busy);
        this._diskRate.text = `${gap('diskBusy')}R ${rate(io.read)} W ${rate(io.written)}`;
        this._diskSpace.text = space
            ? `${gap('diskBusy') || gap('diskRate')}${space.pct}% full` : '';
        this._diskSpace.style = space ? color(space.pct) : '';
        // Disk icon: the worse of activity and space, among those shown
        const diskStyles = [
            this._show('diskBusy') ? color(io.busy) : '',
            this._show('diskSpace') && space ? color(space.pct) : '',
        ];
        this._diskIcon.style = SEVERITY.findLast(c => diskStyles.includes(c)) ?? '';
        const mbs = b => (b / 1048576).toFixed(1);
        this._ioItem.label.text =
            `Disk: ${io.busy}% busy · read ${mbs(io.read)} MB/s · write ${mbs(io.written)} MB/s`;
        this._spaceItem.label.text = space
            ? `Space: ${space.pct}% (${gib(space.used / 1024)} of ${gib(space.size / 1024)} GiB)` : 'Space: —';
        this._spaceItem.label.style = space ? color(space.pct) : '';
        this._diskItem.label.text = `SSD temperature: ${diskTemp ?? '—'} °C`;
    }

    destroy() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        super.destroy();
    }
});

export default class CpuRamUsageExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
