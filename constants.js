// Keep translatable profile names extractable without translating them while
// modules are imported.
export const N_ = text => text;

export const PROFILES = new Map([
    ['performance', {
        icon: 'power-profile-performance-symbolic',
        label: N_('Performance'),
        color: '#ef4444',
    }],
    ['balanced', {
        icon: 'power-profile-balanced-symbolic',
        label: N_('Balanced'),
        color: '#7dd3fc',
    }],
    ['powersave', {
        icon: 'power-profile-power-saver-symbolic',
        label: N_('Power Saver'),
        color: '#86efac',
    }],
]);

// Internal profile ids are also used as the click-cycle order in the panel.
export const PROFILE_ORDER = [
    'performance',
    'balanced',
    'powersave',
];

export const METRICS_MODES = [
    'both',
    'temperature',
    'frequency',
];

// Shared polling interval for external profile sync and CPU info updates.
export const POLL_INTERVAL_SECONDS = 5;
