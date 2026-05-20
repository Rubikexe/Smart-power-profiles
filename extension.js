import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PowerProfileManager} from './powerProfiles.js';
import {ProfileIndicator} from './profileIndicator.js';
import {CpuInfoIndicator} from './cpuInfoIndicator.js';
import {ProcessRuleManager} from './processRules.js';

// The extension class only coordinates long-lived components. Backend commands,
// panel actors, CPU reads, and process scanning live in their own modules.
export default class SmartPowerProfilesExtension extends Extension {
    enable() {
        // Runtime state is rebuilt on every enable() so disable() can fully
        // tear the extension down without leaving stale objects behind.
        this._settings = this.getSettings();
        this._switchTimeoutId = 0;
        this._settingsSignalIds = [];
        this._loggedWarnings = new Set();
        this._manualOverride = false;

        this._profileIndicator = new ProfileIndicator({
            settings: this._settings,
            uuid: this.uuid,
            name: this.metadata.name,
            onCycle: () => this._cycleProfileManually(),
        });
        this._cpuInfoIndicator = new CpuInfoIndicator({
            settings: this._settings,
            uuid: this.uuid,
            warnOnce: this._warnOnce.bind(this),
        });
        this._profileManager = new PowerProfileManager({
            onProfileChanged: profile => this._profileIndicator.updateProfile(profile),
            warnOnce: this._warnOnce.bind(this),
            shouldPauseSync: () => this._shouldPauseProfileSync(),
        });
        this._processRuleManager = new ProcessRuleManager({
            settings: this._settings,
            onRuleStateChanged: state => this._handleProcessRuleState(state),
            warnOnce: this._warnOnce.bind(this),
        });

        this._connectSettingsSignals();
        this._cpuInfoIndicator.refreshMonitoring();

        if (this._profileManager.available) {
            this._refreshProfileSync();
            this._startBootBoostIfEnabled();
            this._processRuleManager.start();
        }
    }

    disable() {
        this._cancelScheduledSwitch();

        for (const signalId of this._settingsSignalIds)
            this._settings.disconnect(signalId);
        this._settingsSignalIds = [];

        this._profileManager?.destroy();
        this._profileManager = null;
        this._processRuleManager?.destroy();
        this._processRuleManager = null;
        this._profileIndicator?.destroy();
        this._profileIndicator = null;
        this._cpuInfoIndicator?.destroy();
        this._cpuInfoIndicator = null;

        this._loggedWarnings.clear();
        this._loggedWarnings = null;
        this._settings = null;
    }

    _connectSettingsSignals() {
        // Settings listeners are connected once per enable(); recreating panel
        // actors must not register duplicate callbacks.
        this._settingsSignalIds.push(
            this._settings.connect('changed::colorize-indicator', () => {
                this._profileIndicator.updateAppearance();
            }),
            this._settings.connect('changed::show-indicator', () => {
                this._refreshProfileSync();
            }),
            this._settings.connect('changed::show-profile-label', () => {
                this._profileIndicator.updateAppearance();
            }),
            this._settings.connect('changed::indicator-order', () => {
                this._profileIndicator.recreate();
            }),
            this._settings.connect('changed::show-cpu-metrics', () => {
                this._cpuInfoIndicator.refreshMonitoring();
            }),
            this._settings.connect('changed::metrics-mode', () => {
                this._cpuInfoIndicator.updateLabel();
            }),
            this._settings.connect('changed::metrics-position', () => {
                this._cpuInfoIndicator.recreate();
            }),
            this._settings.connect('changed::metrics-order', () => {
                this._cpuInfoIndicator.recreate();
            }),
            this._settings.connect('changed::metrics-margin', () => {
                this._cpuInfoIndicator.updateStyle();
            }),
            this._settings.connect('changed::sync-active-profile', () => {
                this._refreshProfileSync();
            }),
            this._settings.connect('changed::enable-process-rules', () => {
                this._manualOverride = false;
                this._processRuleManager.refresh();
            }),
            this._settings.connect('changed::process-scan-interval', () => {
                this._processRuleManager.refresh();
            }),
            this._settings.connect('changed::process-rules', () => {
                this._manualOverride = false;
                this._processRuleManager.refresh();
            })
        );
    }

    _startBootBoostIfEnabled() {
        if (!this._settings.get_boolean('enable-boot-boost'))
            return;

        const startupProfile = this._settings.get_string('startup-profile');

        this._profileManager.applyProfile(startupProfile);

        if (!this._settings.get_boolean('enable-delayed-profile'))
            return;

        const delaySeconds = this._settings.get_uint('delay-seconds');
        this._switchTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            delaySeconds,
            () => {
                const delayedProfile = this._settings.get_string('delayed-profile');
                this._profileManager.applyProfile(delayedProfile);
                this._switchTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _refreshProfileSync() {
        if (!this._profileManager)
            return;

        if (
            this._settings.get_boolean('show-indicator') &&
            this._settings.get_boolean('sync-active-profile')
        )
            this._profileManager.startSync();
        else
            this._profileManager.stopSync();
    }

    _shouldPauseProfileSync() {
        return this._settings.get_boolean('sync-active-profile-pause-on-fullscreen') &&
            this._isFullscreenOrBorderlessActive();
    }

    _isFullscreenOrBorderlessActive() {
        const window = global.display.get_focus_window();

        if (!window)
            return false;

        if (window.is_fullscreen?.() || window.fullscreen)
            return true;

        const windowRect = window.get_frame_rect?.() ?? window.get_buffer_rect?.();
        const monitorIndex = window.get_monitor?.();
        const monitor = Main.layoutManager.monitors[monitorIndex];

        if (!windowRect || !monitor)
            return false;

        // Borderless games often cover the whole monitor without using the
        // compositor's explicit fullscreen state.
        return windowRect.x <= monitor.x &&
            windowRect.y <= monitor.y &&
            windowRect.x + windowRect.width >= monitor.x + monitor.width &&
            windowRect.y + windowRect.height >= monitor.y + monitor.height;
    }

    _cycleProfileManually() {
        this._cancelScheduledSwitch();
        this._manualOverride = true;
        this._profileManager.cycleProfile();
    }

    _handleProcessRuleState({activeRules, stoppedRules, startProfile, stopAction}) {
        // Manual clicks suppress automation only until the next real process
        // transition; after that, configured rules become authoritative again.
        if (this._manualOverride)
            this._manualOverride = false;

        if (activeRules.length > 0) {
            this._cancelScheduledSwitch();
            if (startProfile !== 'nothing')
                this._profileManager.applyProfile(startProfile);
            return;
        }

        if (stoppedRules.length > 0 && stopAction !== 'nothing')
            this._profileManager.applyProfile(stopAction);
    }

    _cancelScheduledSwitch() {
        if (this._switchTimeoutId !== 0) {
            GLib.Source.remove(this._switchTimeoutId);
            this._switchTimeoutId = 0;
        }
    }

    _warnOnce(key, message) {
        if (!this._loggedWarnings || this._loggedWarnings.has(key))
            return;

        this._loggedWarnings.add(key);
        console.warn(message);
    }
}
