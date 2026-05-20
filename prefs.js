import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {createDefaultProcessRule, parseProcessRules, readProcessNames, saveProcessRules} from './processRules.js';

const N_ = text => text;

const PROFILE_DEFINITIONS = [
    {id: 'performance', label: N_('Performance')},
    {id: 'balanced', label: N_('Balanced')},
    {id: 'powersave', label: N_('Power Saver')},
];

const START_ACTION_DEFINITIONS = [
    {id: 'nothing', label: N_('Do nothing')},
    ...PROFILE_DEFINITIONS,
];

const STOP_ACTION_DEFINITIONS = [
    {id: 'nothing', label: N_('Do nothing')},
    {id: 'performance', label: N_('Performance')},
    {id: 'balanced', label: N_('Balanced')},
    {id: 'powersave', label: N_('Power Saver')},
];

const METRICS_MODES = [
    'both',
    'temperature',
    'frequency',
];

const METRICS_POSITIONS = [
    'left',
    'center',
    'right',
];

function profileToIndex(profileId, profiles = PROFILE_DEFINITIONS) {
    const index = profiles.findIndex(profile => profile.id === profileId);
    return index >= 0 ? index : 0;
}

function metricsModeToIndex(mode) {
    const index = METRICS_MODES.indexOf(mode);
    return index >= 0 ? index : 0;
}

function metricsPositionToIndex(position) {
    const index = METRICS_POSITIONS.indexOf(position);
    return index >= 0 ? index : 2;
}

export default class SmartPowerProfilesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Build translated option lists at runtime so xgettext can still see
        // the original English strings in the static definitions above.
        const settings = this.getSettings();
        const profiles = this._translateProfiles(PROFILE_DEFINITIONS);
        const startActions = this._translateProfiles(START_ACTION_DEFINITIONS);
        const stopActions = this._translateProfiles(STOP_ACTION_DEFINITIONS);

        window.add(this._createPanelPage(settings));
        window.add(this._createAutomationPage(window, settings, profiles, startActions, stopActions));
    }

    _createPanelPage(settings) {
        // Panel settings are grouped separately from automation so users can
        // disable visual extras without touching behavior rules.
        const page = new Adw.PreferencesPage({
            title: _('Panel'),
            icon_name: 'preferences-system-symbolic',
        });

        const appearanceGroup = new Adw.PreferencesGroup({
            title: _('Power profile indicator'),
            description: _('Configure the optional panel indicator.'),
        });
        page.add(appearanceGroup);

        const showIndicatorRow = new Adw.SwitchRow({
            title: _('Show panel indicator'),
            subtitle: _('Display the current profile and allow one-click switching'),
        });
        settings.bind(
            'show-indicator',
            showIndicatorRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        appearanceGroup.add(showIndicatorRow);

        const colorizeIndicatorRow = new Adw.SwitchRow({
            title: _('Colorize indicator'),
            subtitle: _('Use red, light blue, and light green for the active profile'),
        });
        settings.bind(
            'colorize-indicator',
            colorizeIndicatorRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        appearanceGroup.add(colorizeIndicatorRow);

        const showProfileLabelRow = new Adw.SwitchRow({
            title: _('Show profile name'),
            subtitle: _('Display the active profile name next to the icon'),
        });
        settings.bind(
            'show-profile-label',
            showProfileLabelRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        appearanceGroup.add(showProfileLabelRow);

        const syncActiveProfileRow = new Adw.SwitchRow({
            title: _('Sync active profile'),
            subtitle: _('Keep the indicator updated after external changes. This may cause stuttering on some systems.'),
        });
        settings.bind(
            'sync-active-profile',
            syncActiveProfileRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        appearanceGroup.add(syncActiveProfileRow);

        const pauseSyncFullscreenRow = new Adw.SwitchRow({
            title: _('Pause sync in fullscreen/borderless'),
            subtitle: _('Avoid profile sync while fullscreen or borderless windows are active'),
        });
        settings.bind(
            'sync-active-profile-pause-on-fullscreen',
            pauseSyncFullscreenRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        appearanceGroup.add(pauseSyncFullscreenRow);

        const indicatorOrderRow = Adw.SpinRow.new_with_range(0, 16, 1);
        indicatorOrderRow.title = _('Indicator order');
        indicatorOrderRow.subtitle = _('Position of the profile indicator within its panel section');
        indicatorOrderRow.value = settings.get_uint('indicator-order');
        indicatorOrderRow.connect('notify::value', row => {
            settings.set_uint('indicator-order', Math.round(row.value));
        });
        appearanceGroup.add(indicatorOrderRow);

        this._bindGroupSensitivity(settings, 'show-indicator', [
            colorizeIndicatorRow,
            showProfileLabelRow,
            syncActiveProfileRow,
            indicatorOrderRow,
        ]);
        this._bindCombinedSensitivity(settings, ['show-indicator', 'sync-active-profile'], [
            pauseSyncFullscreenRow,
        ]);

        const cpuInfoGroup = new Adw.PreferencesGroup({
            title: _('CPU info'),
            description: _('Show CPU temperature and frequency in the panel.'),
        });
        page.add(cpuInfoGroup);

        const showCpuMetricsRow = new Adw.SwitchRow({
            title: _('Show CPU info'),
            subtitle: _('Display temperature and frequency in the panel'),
        });
        settings.bind(
            'show-cpu-metrics',
            showCpuMetricsRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        cpuInfoGroup.add(showCpuMetricsRow);

        const metricsModeRow = new Adw.ComboRow({
            title: _('Info view'),
            subtitle: _('Clicking the panel label cycles through all views'),
            model: Gtk.StringList.new([
                _('Temperature and frequency'),
                _('Temperature only'),
                _('Frequency only'),
            ]),
            selected: metricsModeToIndex(settings.get_string('metrics-mode')),
        });
        metricsModeRow.connect('notify::selected', widget => {
            settings.set_string('metrics-mode', METRICS_MODES[widget.selected]);
        });
        cpuInfoGroup.add(metricsModeRow);

        const metricsPositionRow = new Adw.ComboRow({
            title: _('Panel position'),
            model: Gtk.StringList.new([
                _('Left'),
                _('Center'),
                _('Right'),
            ]),
            selected: metricsPositionToIndex(settings.get_string('metrics-position')),
        });
        metricsPositionRow.connect('notify::selected', widget => {
            settings.set_string('metrics-position', METRICS_POSITIONS[widget.selected]);
        });
        cpuInfoGroup.add(metricsPositionRow);

        const metricsMarginRow = Adw.SpinRow.new_with_range(0, 64, 1);
        metricsMarginRow.title = _('Horizontal margin');
        metricsMarginRow.subtitle = _('Space around the info label in pixels');
        metricsMarginRow.value = settings.get_uint('metrics-margin');
        metricsMarginRow.connect('notify::value', row => {
            settings.set_uint('metrics-margin', Math.round(row.value));
        });
        cpuInfoGroup.add(metricsMarginRow);

        const metricsOrderRow = Adw.SpinRow.new_with_range(0, 16, 1);
        metricsOrderRow.title = _('CPU info order');
        metricsOrderRow.subtitle = _('Position of the CPU info label within its panel section');
        metricsOrderRow.value = settings.get_uint('metrics-order');
        metricsOrderRow.connect('notify::value', row => {
            settings.set_uint('metrics-order', Math.round(row.value));
        });
        cpuInfoGroup.add(metricsOrderRow);

        this._bindGroupSensitivity(settings, 'show-cpu-metrics', [
            metricsModeRow,
            metricsPositionRow,
            metricsMarginRow,
            metricsOrderRow,
        ]);

        return page;
    }

    _createAutomationPage(window, settings, profiles, startActions, stopActions) {
        const page = new Adw.PreferencesPage({
            title: _('Automation'),
            icon_name: 'system-run-symbolic',
        });

        const bootGroup = new Adw.PreferencesGroup({
            title: _('Boot boost'),
            description: _('Choose the power profile used at session start and the profile applied after the delay.'),
        });
        page.add(bootGroup);

        const enableBootBoostRow = new Adw.SwitchRow({
            title: _('Enable boot boost'),
            subtitle: _('Apply one profile at startup and another after the delay'),
        });
        settings.bind(
            'enable-boot-boost',
            enableBootBoostRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        bootGroup.add(enableBootBoostRow);

        const startupProfileRow = this._createProfileRow({
            title: _('Startup profile'),
            subtitle: _('Applied when the extension is enabled'),
            settings,
            key: 'startup-profile',
            profiles,
        });
        bootGroup.add(startupProfileRow);

        const delayedProfileRow = this._createProfileRow({
            title: _('Delayed profile'),
            subtitle: _('Applied after the configured delay'),
            settings,
            key: 'delayed-profile',
            profiles,
        });

        const enableDelayedProfileRow = new Adw.SwitchRow({
            title: _('Enable delayed profile'),
            subtitle: _('Apply another profile after the configured delay'),
        });
        settings.bind(
            'enable-delayed-profile',
            enableDelayedProfileRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        bootGroup.add(enableDelayedProfileRow);
        bootGroup.add(delayedProfileRow);

        const delayRow = Adw.SpinRow.new_with_range(1, 3600, 1);
        delayRow.title = _('Delay');
        delayRow.subtitle = _('Seconds before switching to the delayed profile');
        delayRow.value = settings.get_uint('delay-seconds');
        delayRow.connect('notify::value', row => {
            settings.set_uint('delay-seconds', Math.round(row.value));
        });
        bootGroup.add(delayRow);

        this._bindGroupSensitivity(settings, 'enable-boot-boost', [
            startupProfileRow,
            enableDelayedProfileRow,
        ]);
        this._bindCombinedSensitivity(settings, ['enable-boot-boost', 'enable-delayed-profile'], [
            delayedProfileRow,
            delayRow,
        ]);

        const processGroup = new Adw.PreferencesGroup({
            title: _('Automatic power mode switching'),
            description: _('Choose which power mode should be applied when a selected process starts or stops.'),
        });
        page.add(processGroup);

        const enableProcessRulesRow = new Adw.SwitchRow({
            title: _('Automatic power mode switching'),
            subtitle: _('Apply the assigned power mode when selected processes are detected'),
            active: settings.get_boolean('enable-process-rules'),
        });
        let updatingProcessRulesRow = false;
        const syncProcessRulesRow = () => {
            updatingProcessRulesRow = true;
            enableProcessRulesRow.active = settings.get_boolean('enable-process-rules');
            updatingProcessRulesRow = false;
        };
        settings.connect('changed::enable-process-rules', syncProcessRulesRow);
        enableProcessRulesRow.connect('notify::active', row => {
            if (updatingProcessRulesRow)
                return;

            if (!row.active) {
                settings.set_boolean('enable-process-rules', false);
                return;
            }

            // Do not enable periodic process scanning until the user has seen
            // the warning about possible stuttering in games and applications.
            syncProcessRulesRow();
            this._showProcessRulesWarning(window, () => {
                settings.set_boolean('enable-process-rules', true);
            });
        });
        processGroup.add(enableProcessRulesRow);

        const processScanIntervalRow = Adw.SpinRow.new_with_range(5, 60, 1);
        processScanIntervalRow.title = _('Scan interval');
        processScanIntervalRow.subtitle = _('Seconds between full process scans');
        processScanIntervalRow.value = settings.get_uint('process-scan-interval');
        processScanIntervalRow.connect('notify::value', row => {
            settings.set_uint('process-scan-interval', Math.round(row.value));
        });
        processGroup.add(processScanIntervalRow);

        const searchRow = new Adw.ActionRow({
            title: _('Process names'),
            subtitle: _('Enter a process name and select it from the list below'),
        });
        const searchEntry = new Gtk.SearchEntry({
            placeholder_text: _('Process name'),
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        const refreshProcessesButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: _('Refresh running processes'),
            valign: Gtk.Align.CENTER,
        });
        refreshProcessesButton.add_css_class('flat');
        searchRow.add_suffix(searchEntry);
        searchRow.add_suffix(refreshProcessesButton);
        processGroup.add(searchRow);

        const suggestionsGroup = new Adw.PreferencesGroup({
            title: _('Running processes'),
            description: _('Select a running process to add it to the rules.'),
        });
        page.add(suggestionsGroup);
        let suggestionRows = [];
        let runningProcessNames = [];
        const selectedProcessesGroup = new Adw.PreferencesGroup({
            title: _('Selected processes'),
            description: _('Selected processes that apply the selected power mode when started.'),
        });
        page.add(selectedProcessesGroup);
        let processRows = [];
        const expandedRules = new Set();

        const renderProcessRows = () => {
            // The selected rule list is rebuilt from settings after each edit.
            // expandedRules preserves open rows across those rebuilds.
            for (const row of processRows)
                selectedProcessesGroup.remove(row);
            processRows = [];

            const filter = searchEntry.text.trim().toLowerCase();
            const rules = parseProcessRules(settings)
                .filter(rule => rule.name.toLowerCase().includes(filter))
                .sort((a, b) => a.name.localeCompare(b.name));

            for (const rule of rules) {
                const row = new Adw.ExpanderRow({
                    title: rule.name,
                    subtitle: rule.enabled ? _('Enabled') : _('Disabled'),
                    expanded: expandedRules.has(rule.name),
                });
                row.connect('notify::expanded', widget => {
                    if (widget.expanded)
                        expandedRules.add(rule.name);
                    else
                        expandedRules.delete(rule.name);
                });
                const enabledRow = new Adw.SwitchRow({
                    title: _('Enabled'),
                    active: rule.enabled,
                });
                enabledRow.connect('notify::active', widget => {
                    this._updateProcessRule(settings, rule.name, {
                        enabled: widget.active,
                    });
                });
                row.add_row(enabledRow);

                const pauseScanningRow = new Adw.SwitchRow({
                    title: _('Pause full scanning while running'),
                    subtitle: _('Track only this process after it is detected. Other automatic power mode changes will not work while it is running.'),
                    active: rule.pauseFullScanningWhileRunning !== false,
                });
                pauseScanningRow.connect('notify::active', widget => {
                    this._updateProcessRule(settings, rule.name, {
                        pauseFullScanningWhileRunning: widget.active,
                    });
                });
                row.add_row(pauseScanningRow);

                const startProfileRow = this._createRuleChoiceRow({
                    title: _('When process starts'),
                    selectedId: rule.startProfile,
                    options: startActions,
                    onSelected: startProfile => {
                        this._updateProcessRule(settings, rule.name, {startProfile});
                    },
                });
                row.add_row(startProfileRow);

                const stopActionRow = this._createRuleChoiceRow({
                    title: _('When process stops'),
                    selectedId: rule.stopAction,
                    options: stopActions,
                    onSelected: stopAction => {
                        this._updateProcessRule(settings, rule.name, {stopAction});
                    },
                });
                row.add_row(stopActionRow);

                const removeButton = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                });
                removeButton.add_css_class('flat');
                removeButton.connect('clicked', () => {
                    const updatedRules = parseProcessRules(settings)
                        .filter(candidate => candidate.name !== rule.name);
                    saveProcessRules(settings, updatedRules);
                });
                row.add_suffix(removeButton);
                selectedProcessesGroup.add(row);
                processRows.push(row);
            }
        };

        const renderSuggestionRows = () => {
            // Suggestions are intentionally hidden until typing starts so the
            // selected rules remain the main content of this page.
            for (const row of suggestionRows)
                suggestionsGroup.remove(row);
            suggestionRows = [];

            const filter = searchEntry.text.trim().toLowerCase();
            suggestionsGroup.visible = filter.length > 0;

            if (!filter)
                return;

            const configuredNames = new Set(parseProcessRules(settings).map(rule => rule.name));
            const suggestions = runningProcessNames
                .filter(name => !configuredNames.has(name))
                .filter(name => !filter || name.toLowerCase().includes(filter))
                .slice(0, 12);

            for (const processName of suggestions) {
                const row = new Adw.ActionRow({
                    title: processName,
                    activatable: true,
                });
                row.connect('activated', () => {
                    this._addProcessRule(settings, processName);
                    searchEntry.text = '';
                });
                suggestionsGroup.add(row);
                suggestionRows.push(row);
            }
        };

        const refreshRunningProcesses = async () => {
            runningProcessNames = await this._loadRunningProcessNames();
            renderSuggestionRows();
        };

        refreshProcessesButton.connect('clicked', refreshRunningProcesses);

        searchEntry.connect('search-changed', () => {
            renderProcessRows();
            renderSuggestionRows();
        });
        searchEntry.connect('activate', () => {
            const processName = searchEntry.text.trim();

            if (!processName)
                return;

            this._addProcessRule(settings, processName);
            searchEntry.text = '';
        });
        settings.connect('changed::process-rules', () => {
            renderProcessRows();
            renderSuggestionRows();
        });
        renderProcessRows();
        refreshRunningProcesses();

        this._bindGroupSensitivity(settings, 'enable-process-rules', [
            processScanIntervalRow,
            searchRow,
            suggestionsGroup,
            selectedProcessesGroup,
        ]);

        return page;
    }

    _translateProfiles(profiles) {
        return profiles.map(profile => ({
            ...profile,
            label: _(profile.label),
        }));
    }

    _showProcessRulesWarning(window, onEnable) {
        const dialog = new Adw.AlertDialog({
            heading: _('Automatic power mode switching can cause stuttering'),
            body: _('Automatic power mode switching periodically scans running processes to detect when a configured power mode should activate. On some systems, these full scans can cause brief stutters in games or other applications. Per-process pause scanning is enabled by default to avoid potential stutters in that game or application. While a process is being tracked this way, other automatic power mode changes will not work until it exits.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('enable', _('Enable automatic switching'));
        dialog.set_close_response('cancel');
        dialog.set_default_response('enable');
        dialog.set_response_appearance('enable', Adw.ResponseAppearance.SUGGESTED);
        dialog.choose(window, null, (source, result) => {
            if (source.choose_finish(result) === 'enable')
                onEnable();
        });
    }

    _addProcessRule(settings, processName) {
        const currentRules = parseProcessRules(settings);

        if (!currentRules.some(rule => rule.name === processName))
            saveProcessRules(settings, [...currentRules, createDefaultProcessRule(processName)]);
    }

    _updateProcessRule(settings, processName, updates) {
        const updatedRules = parseProcessRules(settings).map(rule =>
            rule.name === processName ? {...rule, ...updates} : rule
        );
        saveProcessRules(settings, updatedRules);
    }

    _createRuleChoiceRow({title, selectedId, options, onSelected}) {
        const row = new Adw.ComboRow({
            title,
            model: Gtk.StringList.new(options.map(option => option.label)),
            selected: profileToIndex(selectedId, options),
        });
        row.connect('notify::selected', widget => {
            onSelected(options[widget.selected].id);
        });
        return row;
    }

    async _loadRunningProcessNames() {
        // Suggestions use the same filtered aliases as runtime matching so a
        // name chosen here behaves the same after it becomes a rule.
        const processNames = new Set();

        try {
            const procRoot = Gio.File.new_for_path('/proc');
            const enumerator = procRoot.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) {
                if (!/^\d+$/.test(info.get_name()))
                    continue;

                const names = await readProcessNames(procRoot.get_child(info.get_name()));
                for (const name of names)
                    processNames.add(name);
            }
        } catch {
            return [];
        }

        return [...processNames].sort((a, b) => a.localeCompare(b));
    }

    _createProfileRow({title, subtitle, settings, key, profiles}) {
        const row = new Adw.ComboRow({
            title,
            subtitle,
            model: Gtk.StringList.new(profiles.map(profile => profile.label)),
            selected: profileToIndex(settings.get_string(key), profiles),
        });

        row.connect('notify::selected', widget => {
            settings.set_string(key, profiles[widget.selected].id);
        });

        return row;
    }

    _bindGroupSensitivity(settings, key, widgets) {
        // Keep dependent controls visible but disabled when their feature toggle
        // is off, which makes the relationship clear in preferences.
        const updateSensitivity = () => {
            const enabled = settings.get_boolean(key);

            for (const widget of widgets)
                widget.sensitive = enabled;
        };

        updateSensitivity();
        settings.connect(`changed::${key}`, updateSensitivity);
    }

    _bindCombinedSensitivity(settings, keys, widgets) {
        const updateSensitivity = () => {
            const enabled = keys.every(key => settings.get_boolean(key));

            for (const widget of widgets)
                widget.sensitive = enabled;
        };

        updateSensitivity();
        for (const key of keys)
            settings.connect(`changed::${key}`, updateSensitivity);
    }
}
