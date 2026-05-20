import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {PROFILE_ORDER, POLL_INTERVAL_SECONDS} from './constants.js';

// Backend adapters keep the rest of the extension independent from the system
// tool used to manage power profiles.
const PROFILE_BACKENDS = [
    {
        id: 'tuned',
        executable: 'tuned-adm',
        toSystemProfile: new Map([
            ['performance', 'throughput-performance'],
            ['balanced', 'balanced'],
            ['powersave', 'powersave'],
        ]),
        toAppProfile: new Map([
            ['throughput-performance', 'performance'],
            ['balanced', 'balanced'],
            ['powersave', 'powersave'],
        ]),
        buildApplyCommand(systemProfile) {
            return ['tuned-adm', 'profile', systemProfile];
        },
        activeCommand: ['tuned-adm', 'active'],
        parseActiveProfile(stdout) {
            const match = stdout.match(/Current active profile:\s*(\S+)/);
            return match?.[1] ?? null;
        },
    },
    {
        id: 'powerprofilesctl',
        executable: 'powerprofilesctl',
        toSystemProfile: new Map([
            ['performance', 'performance'],
            ['balanced', 'balanced'],
            ['powersave', 'power-saver'],
        ]),
        toAppProfile: new Map([
            ['performance', 'performance'],
            ['balanced', 'balanced'],
            ['power-saver', 'powersave'],
        ]),
        buildApplyCommand(systemProfile) {
            return ['powerprofilesctl', 'set', systemProfile];
        },
        activeCommand: ['powerprofilesctl', 'get'],
        parseActiveProfile(stdout) {
            return stdout.trim() || null;
        },
    },
];

// Normalizes profile operations across supported system tools and keeps the UI
// synchronized with changes made outside the extension.
export class PowerProfileManager {
    constructor({onProfileChanged, warnOnce, shouldPauseSync}) {
        this._onProfileChanged = onProfileChanged;
        this._warnOnce = warnOnce;
        this._shouldPauseSync = shouldPauseSync;
        this._enabled = true;
        this._syncTimeoutId = 0;
        this._currentProfile = null;
        this._backend = this._detectBackend();
    }

    get available() {
        return this._backend !== null;
    }

    startSync() {
        if (!this._backend || this._syncTimeoutId !== 0)
            return;

        // This optional polling keeps the indicator synchronized with profile
        // changes made outside the extension. It is disabled by default because
        // running backend commands periodically can cause stutters on some systems.
        this._syncActiveProfileIfAllowed();
        this._syncTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            POLL_INTERVAL_SECONDS,
            () => {
                this._syncActiveProfileIfAllowed();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    stopSync() {
        if (this._syncTimeoutId !== 0) {
            GLib.Source.remove(this._syncTimeoutId);
            this._syncTimeoutId = 0;
        }
    }

    destroy() {
        this._enabled = false;

        this.stopSync();

        this._backend = null;
        this._currentProfile = null;
    }

    cycleProfile() {
        if (!this._backend)
            return;

        const currentIndex = PROFILE_ORDER.indexOf(this._currentProfile);
        const nextIndex = currentIndex >= 0
            ? (currentIndex + 1) % PROFILE_ORDER.length
            : 0;

        this.applyProfile(PROFILE_ORDER[nextIndex]);
    }

    applyProfile(profile) {
        if (!this._backend || !this._enabled)
            return;

        // Convert the extension's stable profile ids into the command syntax
        // required by the detected backend.
        const backend = this._backend;
        const systemProfile = backend.toSystemProfile.get(profile);

        if (!systemProfile) {
            this._warnOnce(`unsupported-profile-${profile}`, `Smart Power Profiles: ignoring unsupported profile "${profile}"`);
            return;
        }

        this._setCurrentProfile(profile);

        try {
            const subprocess = Gio.Subprocess.new(
                backend.buildApplyCommand(systemProfile),
                Gio.SubprocessFlags.NONE
            );

            subprocess.wait_check_async(null, (process, result) => {
                try {
                    process.wait_check_finish(result);
                } catch (error) {
                    this._warnOnce(`apply-${backend.id}-${systemProfile}`, `Smart Power Profiles: failed to apply ${backend.id} profile "${systemProfile}": ${error.message}`);
                }
            });
        } catch (error) {
            this._warnOnce(`start-${backend.id}-${systemProfile}`, `Smart Power Profiles: failed to start ${backend.id} for profile "${systemProfile}": ${error.message}`);
        }
    }

    syncActiveProfile() {
        // Convert the backend-specific active profile back into the extension's
        // internal ids before updating panel UI.
        if (!this._backend)
            return;

        const backend = this._backend;

        try {
            const subprocess = Gio.Subprocess.new(
                backend.activeCommand,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            subprocess.communicate_utf8_async(null, null, (process, result) => {
                try {
                    const [, stdout] = process.communicate_utf8_finish(result);
                    const systemProfile = backend.parseActiveProfile(stdout);
                    const profile = backend.toAppProfile.get(systemProfile);

                    if (profile && this._enabled)
                        this._setCurrentProfile(profile);
                } catch (error) {
                    this._warnOnce(`read-active-${backend.id}`, `Smart Power Profiles: failed to read active ${backend.id} profile: ${error.message}`);
                }
            });
        } catch (error) {
            this._warnOnce(`start-active-${backend.id}`, `Smart Power Profiles: failed to start ${backend.id} active-profile command: ${error.message}`);
        }
    }

    _syncActiveProfileIfAllowed() {
        if (this._shouldPauseSync?.())
            return;

        this.syncActiveProfile();
    }

    _setCurrentProfile(profile) {
        this._currentProfile = profile;
        this._onProfileChanged(profile);
    }

    _detectBackend() {
        // Prefer TuneD when both tools exist; Fedora 44 uses it, while
        // Ubuntu 26.04 uses powerprofilesctl instead.
        for (const backend of PROFILE_BACKENDS) {
            if (GLib.find_program_in_path(backend.executable))
                return backend;
        }

        this._warnOnce('no-profile-backend', 'Smart Power Profiles: neither tuned-adm nor powerprofilesctl was found');
        return null;
    }
}
