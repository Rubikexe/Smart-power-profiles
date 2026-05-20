import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

// When several matching rules are active at once, the most demanding profile
// wins so a low-power rule cannot unexpectedly override a performance rule.
const PROFILE_PRIORITY = new Map([
    ['powersave', 0],
    ['balanced', 1],
    ['performance', 2],
]);

// Some applications rewrite argv[0] into a long process title containing many
// command-line options. Those values are not useful rule names or suggestions.
const MAX_PROCESS_NAME_LENGTH = 50;

// Rules are stored as JSON strings in GSettings because every process needs
// several independent fields, not just a single name.
export function createDefaultProcessRule(name) {
    return {
        name,
        enabled: true,
        startProfile: 'performance',
        stopAction: 'balanced',
        pauseFullScanningWhileRunning: true,
    };
}

export function parseProcessRules(settings) {
    return settings.get_strv('process-rules')
        .map(serializedRule => {
            try {
                return JSON.parse(serializedRule);
            } catch {
                return null;
            }
        })
        .filter(rule => rule?.name);
}

export function saveProcessRules(settings, rules) {
    settings.set_strv(
        'process-rules',
        rules.map(rule => JSON.stringify(rule))
    );
}

// Return every useful process alias exposed by procfs. Native applications are
// usually covered by comm, while Wine/Proton games often expose the Windows
// executable name only in cmdline arguments.
export async function readProcessNames(processDir) {
    const names = new Set();
    const comm = await readTextFile(processDir.get_child('comm'));
    const cmdline = await readTextFile(processDir.get_child('cmdline'));
    const arguments_ = cmdline.split('\0').filter(Boolean);
    const executable = arguments_[0] ?? '';

    if (isUsableProcessName(comm))
        names.add(comm);

    for (const argument of arguments_) {
        const basename = GLib.path_get_basename(argument.replaceAll('\\', '/'));

        if (!basename)
            continue;

        if (
            isUsableProcessName(basename) &&
            (argument === executable || basename.toLowerCase().endsWith('.exe'))
        )
            names.add(basename);
    }

    return names;
}

function isUsableProcessName(name) {
    return name.length > 0 && name.length <= MAX_PROCESS_NAME_LENGTH;
}

async function readTextFile(file) {
    try {
        const [contents] = await file.load_contents_async(null);
        return new TextDecoder().decode(contents).trim();
    } catch {
        return '';
    }
}

// Poll /proc and report only meaningful state changes to the extension. The
// profile application itself stays outside this class so policy and detection
// remain separate.
export class ProcessRuleManager {
    constructor({settings, onRuleStateChanged, warnOnce}) {
        this._settings = settings;
        this._onRuleStateChanged = onRuleStateChanged;
        this._warnOnce = warnOnce;
        this._enabled = true;
        this._timeoutId = 0;
        this._activeRuleNames = new Set();
        this._trackedRulePids = new Map();
    }

    start() {
        if (!this._settings.get_boolean('enable-process-rules'))
            return;

        this._checkProcesses();
        this._scheduleFullScan();
    }

    refresh() {
        this.stop();
        this._enabled = true;
        this._activeRuleNames = new Set();
        this._trackedRulePids = new Map();
        this.start();
    }

    stop() {
        if (this._timeoutId !== 0) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    destroy() {
        this._enabled = false;
        this.stop();
    }

    async _checkProcesses() {
        if (!this._enabled || !this._settings.get_boolean('enable-process-rules'))
            return;

        const rules = parseProcessRules(this._settings)
            .filter(rule => rule.enabled);

        if (rules.length === 0) {
            this._updateRuleState([], []);
            return;
        }

        try {
            const runningProcesses = await this._loadRunningProcesses();
            const activeRules = rules.filter(rule => runningProcesses.has(rule.name));
            const stoppedRules = rules.filter(rule =>
                this._activeRuleNames.has(rule.name) &&
                !runningProcesses.has(rule.name)
            );

            this._updateRuleState(activeRules, stoppedRules);
            this._startTrackingRules(activeRules, runningProcesses);
        } catch (error) {
            this._warnOnce('scan-processes', `Smart Power Profiles: failed to scan running processes: ${error.message}`);
        }
    }

    async _loadRunningProcesses() {
        // Linux exposes one directory per PID in /proc. A full scan records
        // every matching alias together with the PIDs that exposed it.
        const processesByName = new Map();
        const procRoot = Gio.File.new_for_path('/proc');
        const enumerator = procRoot.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null
        );

        for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) {
            if (!/^\d+$/.test(info.get_name()))
                continue;

            const pid = info.get_name();
            const names = await readProcessNames(procRoot.get_child(pid));
            for (const name of names) {
                if (!processesByName.has(name))
                    processesByName.set(name, new Set());

                processesByName.get(name).add(pid);
            }
        }

        return processesByName;
    }

    _startTrackingRules(activeRules, runningProcesses) {
        // Once a configured rule is active, full scans can be paused for rules
        // that opt in and replaced with cheap checks of their known PID paths.
        this._trackedRulePids = new Map(
            activeRules
                .filter(rule => rule.pauseFullScanningWhileRunning !== false)
                .map(rule => [rule.name, new Set(runningProcesses.get(rule.name) ?? [])])
                .filter(([, pids]) => pids.size > 0)
        );

        if (this._trackedRulePids.size > 0)
            this._scheduleTrackedPidChecks();
        else
            this._scheduleFullScan();
    }

    _scheduleFullScan() {
        this._replaceTimeout(
            this._settings.get_uint('process-scan-interval'),
            () => {
                this._checkProcesses();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _scheduleTrackedPidChecks() {
        this._replaceTimeout(
            this._settings.get_uint('process-scan-interval'),
            () => {
                this._checkTrackedPids();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _replaceTimeout(intervalSeconds, callback) {
        this.stop();
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            intervalSeconds,
            callback
        );
    }

    _checkTrackedPids() {
        // Do not scan the whole system while a tracked rule still has at least
        // one live PID. A full scan is resumed only after a tracked rule loses
        // all known PIDs, which also catches quick restarts under a new PID.
        for (const [ruleName, pids] of this._trackedRulePids) {
            const livePids = new Set(
                [...pids].filter(pid =>
                    GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS)
                )
            );

            if (livePids.size === 0) {
                this._trackedRulePids.delete(ruleName);
                this._scheduleFullScan();
                this._checkProcesses();
                return;
            }

            this._trackedRulePids.set(ruleName, livePids);
        }
    }

    _updateRuleState(activeRules, stoppedRules) {
        // Avoid reapplying profiles on every poll when the active rule set did
        // not change since the previous scan.
        const nextActiveRuleNames = new Set(activeRules.map(rule => rule.name));

        if (
            this._setsEqual(nextActiveRuleNames, this._activeRuleNames) &&
            stoppedRules.length === 0
        )
            return;

        this._activeRuleNames = nextActiveRuleNames;
        this._onRuleStateChanged({
            activeRules,
            stoppedRules,
            startProfile: this._getHighestPriorityProfile(activeRules),
            stopAction: this._getHighestPriorityStopAction(stoppedRules),
        });
    }

    _getHighestPriorityProfile(rules) {
        const actionableRules = rules.filter(rule => rule.startProfile !== 'nothing');

        if (actionableRules.length === 0)
            return 'nothing';

        return actionableRules.reduce((bestProfile, rule) => {
            if (!bestProfile)
                return rule.startProfile;

            return PROFILE_PRIORITY.get(rule.startProfile) > PROFILE_PRIORITY.get(bestProfile)
                ? rule.startProfile
                : bestProfile;
        }, null);
    }

    _getHighestPriorityStopAction(rules) {
        const actionableRules = rules.filter(rule => rule.stopAction !== 'nothing');

        if (actionableRules.length === 0)
            return 'nothing';

        return actionableRules.reduce((bestProfile, rule) =>
            PROFILE_PRIORITY.get(rule.stopAction) > PROFILE_PRIORITY.get(bestProfile)
                ? rule.stopAction
                : bestProfile,
        actionableRules[0].stopAction);
    }

    _setsEqual(first, second) {
        return first.size === second.size &&
            [...first].every(value => second.has(value));
    }
}
