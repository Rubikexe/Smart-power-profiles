import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {METRICS_MODES, POLL_INTERVAL_SECONDS} from './constants.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const CPU_HWMON_NAMES = new Set([
    'coretemp',
    'k10temp',
    'zenpower',
    'peci_cputemp',
]);

// Owns the optional CPU info label and the minimum polling needed for its
// currently selected display mode.
export class CpuInfoIndicator {
    constructor({settings, uuid, warnOnce}) {
        this._settings = settings;
        this._uuid = `${uuid}-metrics`;
        this._warnOnce = warnOnce;
        this._enabled = true;
        this._timeoutId = 0;
        this._generation = 0;
        this._temperaturePath = null;
        this._frequencyPaths = [];
        this._create();
    }

    destroy() {
        this._enabled = false;
        this.stopMonitoring();
        this._label?.destroy();
        this._indicator?.destroy();
        delete Main.panel.statusArea[this._uuid];
        this._indicator = null;
        this._label = null;
    }

    recreate() {
        this._label?.destroy();
        this._indicator?.destroy();
        delete Main.panel.statusArea[this._uuid];
        this._indicator = null;
        this._label = null;
        this._create();
        this.updateLabel();
    }

    async refreshMonitoring() {
        // CPU info is only polled while visible. The generation counter prevents
        // stale async reads from restarting timers after settings change.
        if (!this._settings.get_boolean('show-cpu-metrics')) {
            this.stopMonitoring();
            return;
        }

        const generation = ++this._generation;

        if (this._timeoutId === 0) {
            await this.updateLabel();

            if (!this._canUpdate(generation))
                return;

            this._timeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                POLL_INTERVAL_SECONDS,
                () => {
                    this.updateLabel();
                    return GLib.SOURCE_CONTINUE;
                }
            );
        } else {
            await this.updateLabel();
        }
    }

    stopMonitoring() {
        if (this._timeoutId !== 0) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }

        this._generation++;
    }

    cycleMode() {
        const currentMode = this._settings.get_string('metrics-mode');
        const currentIndex = METRICS_MODES.indexOf(currentMode);
        const nextIndex = currentIndex >= 0
            ? (currentIndex + 1) % METRICS_MODES.length
            : 0;

        this._settings.set_string('metrics-mode', METRICS_MODES[nextIndex]);
    }

    updateStyle() {
        if (!this._indicator)
            return;

        const margin = this._settings.get_uint('metrics-margin');
        this._indicator.style = `margin-left: ${margin}px; margin-right: ${margin}px;`;
    }

    async updateLabel() {
        // Read only the data needed by the currently selected display mode.
        if (!this._label || !this._settings.get_boolean('show-cpu-metrics'))
            return;

        const mode = this._settings.get_string('metrics-mode');
        let temperature = null;
        let frequency = null;

        if (mode === 'both' || mode === 'temperature') {
            await this._ensureTemperatureSource();
            temperature = await this._readTemperature();
        }

        if (mode === 'both' || mode === 'frequency') {
            this._ensureFrequencySources();
            frequency = await this._readFrequency();
        }

        if (!this._label || !this._settings.get_boolean('show-cpu-metrics'))
            return;

        if (mode === 'temperature')
            this._label.text = temperature ?? '--°C';
        else if (mode === 'frequency')
            this._label.text = frequency ?? '-- GHz';
        else
            this._label.text = `${temperature ?? '--°C'} | ${frequency ?? '-- GHz'}`;
    }

    _create() {
        // CPU info indicator: one click cycles through both/temp/frequency
        // display modes without opening a menu.
        this._indicator = new PanelMenu.Button(0.0, _('CPU Info'), true);

        const clickGesture = new Clutter.ClickGesture();
        clickGesture.set_recognize_on_press(true);
        clickGesture.connectObject('recognize', () => {
            this.cycleMode();
        }, this._indicator);
        this._indicator.add_action(clickGesture);

        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._indicator.add_child(this._label);

        Main.panel.addToStatusArea(
            this._uuid,
            this._indicator,
            this._settings.get_uint('metrics-order'),
            this._getPosition()
        );
        this._settings.bind(
            'show-cpu-metrics',
            this._indicator,
            'visible',
            Gio.SettingsBindFlags.DEFAULT
        );
        this.updateStyle();
    }

    _getPosition() {
        const position = this._settings.get_string('metrics-position');
        return ['left', 'center', 'right'].includes(position) ? position : 'right';
    }

    async _ensureTemperatureSource() {
        // Sources are discovered lazily so temperature-only and frequency-only
        // modes avoid unnecessary probing.
        if (!this._temperaturePath)
            this._temperaturePath = await this._findTemperaturePath();
    }

    _ensureFrequencySources() {
        if (this._frequencyPaths.length === 0)
            this._frequencyPaths = this._findFrequencyPaths();
    }

    _canUpdate(generation) {
        return this._enabled &&
            generation === this._generation &&
            this._settings?.get_boolean('show-cpu-metrics');
    }

    async _findTemperaturePath() {
        // CPU vendors expose package temperature through different hwmon
        // drivers; prefer package-style labels and fall back to temp1_input.
        try {
            const hwmonRoot = Gio.File.new_for_path('/sys/class/hwmon');
            const enumerator = hwmonRoot.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) {
                if (
                    info.get_file_type() !== Gio.FileType.DIRECTORY &&
                    info.get_file_type() !== Gio.FileType.SYMBOLIC_LINK
                )
                    continue;

                const hwmonDir = hwmonRoot.get_child(info.get_name());
                const name = await this._readTextFile(hwmonDir.get_child('name').get_path());

                if (!CPU_HWMON_NAMES.has(name))
                    continue;

                const preferredInputs = [
                    ['temp1_input', 'temp1_label'],
                    ['temp2_input', 'temp2_label'],
                    ['temp3_input', 'temp3_label'],
                ];

                for (const [inputFile, labelFile] of preferredInputs) {
                    const inputPath = hwmonDir.get_child(inputFile).get_path();
                    const label = await this._readTextFile(hwmonDir.get_child(labelFile).get_path());

                    if (
                        GLib.file_test(inputPath, GLib.FileTest.EXISTS) &&
                        ['Package id 0', 'Tctl', 'Tdie', 'Die'].includes(label)
                    )
                        return inputPath;
                }

                const fallbackPath = hwmonDir.get_child('temp1_input').get_path();
                if (GLib.file_test(fallbackPath, GLib.FileTest.EXISTS))
                    return fallbackPath;
            }
        } catch (error) {
            this._warnOnce('discover-temperature', `Smart Power Profiles: failed to discover CPU temperature source: ${error.message}`);
        }

        return null;
    }

    _findFrequencyPaths() {
        // Read one current-frequency value per cpufreq policy and average them
        // for a compact whole-CPU value in the panel.
        const paths = [];

        try {
            const cpufreqRoot = Gio.File.new_for_path('/sys/devices/system/cpu/cpufreq');
            const enumerator = cpufreqRoot.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) {
                if (
                    (
                        info.get_file_type() !== Gio.FileType.DIRECTORY &&
                        info.get_file_type() !== Gio.FileType.SYMBOLIC_LINK
                    ) ||
                    !info.get_name().startsWith('policy')
                )
                    continue;

                const path = cpufreqRoot
                    .get_child(info.get_name())
                    .get_child('scaling_cur_freq')
                    .get_path();

                if (GLib.file_test(path, GLib.FileTest.EXISTS))
                    paths.push(path);
            }
        } catch (error) {
            this._warnOnce('discover-frequency', `Smart Power Profiles: failed to discover CPU frequency sources: ${error.message}`);
        }

        return paths;
    }

    async _readTemperature() {
        if (!this._temperaturePath)
            return null;

        const millidegrees = Number.parseInt(await this._readTextFile(this._temperaturePath), 10);
        return Number.isFinite(millidegrees)
            ? `${Math.round(millidegrees / 1000)}°C`
            : null;
    }

    async _readFrequency() {
        if (this._frequencyPaths.length === 0)
            return null;

        const frequencies = (await Promise.all(
            this._frequencyPaths.map(path => this._readTextFile(path))
        ))
            .map(value => Number.parseInt(value, 10))
            .filter(value => Number.isFinite(value));

        if (frequencies.length === 0)
            return null;

        const averageKhz = frequencies.reduce((sum, value) => sum + value, 0) / frequencies.length;
        return `${(averageKhz / 1_000_000).toFixed(2)} GHz`;
    }

    async _readTextFile(path) {
        try {
            const file = Gio.File.new_for_path(path);
            const [contents] = await file.load_contents_async(null);
            return new TextDecoder().decode(contents).trim();
        } catch {
            return '';
        }
    }
}
