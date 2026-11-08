import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
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

function color(pct) {
    if (pct >= 90)
        return 'color: #ff6b6b;';
    if (pct >= 80)
        return 'color: #ffb347;';
    return '';
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'CPU & RAM Usage');

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._cpu = new St.Label({text: 'CPU …', y_align: Clutter.ActorAlign.CENTER});
        const sep = new St.Label({text: ' · ', y_align: Clutter.ActorAlign.CENTER});
        this._ram = new St.Label({text: 'RAM …', y_align: Clutter.ActorAlign.CENTER});
        for (const l of [this._cpu, sep, this._ram]) {
            l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            box.add_child(l);
        }
        this.add_child(box);

        this._cpuItem = new PopupMenu.PopupMenuItem('CPU', {reactive: false});
        this._ramItem = new PopupMenu.PopupMenuItem('RAM', {reactive: false});
        this.menu.addMenuItem(this._cpuItem);
        this.menu.addMenuItem(this._ramItem);

        this._prev = readCpuTimes();
        this._update();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _update() {
        try {
            const cur = readCpuTimes();
            const dTotal = cur.total - this._prev.total;
            const dIdle = cur.idle - this._prev.idle;
            this._prev = cur;
            const cpu = dTotal > 0 ? Math.round(100 * (1 - dIdle / dTotal)) : 0;

            const mem = readMemory();
            const ram = mem.total > 0 ? Math.round(100 * mem.used / mem.total) : 0;

            this._cpu.text = `CPU ${cpu}%`;
            this._ram.text = `RAM ${ram}%`;
            this._cpu.style = color(cpu);
            this._ram.style = color(ram);
            this._cpuItem.label.text = `CPU: ${cpu}%`;
            this._ramItem.label.text =
                `RAM: ${ram}% (${gib(mem.used)} of ${gib(mem.total)} GiB)`;
        } catch (e) {
            logError(e);
        }
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
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
