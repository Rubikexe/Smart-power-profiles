# Smart Power Profiles

GNOME Shell extension for GNOME 50. It can:

1. apply a power profile when the extension is enabled;
2. wait for a configurable delay;
3. switch to a second power profile;
4. automatically switch power modes when selected processes start or stop.

The automatic startup switching can be disabled entirely in preferences.
Automatic power mode switching can also be enabled separately and uses detected
process names, including Windows executable names exposed by Wine/Proton when
available. It periodically scans running processes and may cause brief stutters
on some systems. Each process entry pauses full scans by default after its
process is detected and tracks only the known PID paths until that process
exits.

Optionally, it also shows a panel indicator that uses the same symbolic power
profile icons as GNOME Shell. A left click cycles through:

`performance → balanced → powersave → performance`

User-facing profiles:

- `performance`
- `balanced`
- `powersave`

Internally, `performance` is mapped to TuneD's Fedora profile name
`throughput-performance`.

If the user changes the profile manually from the panel indicator before the
scheduled switch happens, the pending automatic switch is cancelled.

The panel indicator can optionally:

- colorize the current profile icon;
- show the current profile name next to the icon.

The indicator can also periodically synchronize with profile changes made
outside the extension, but this is disabled by default because running the
backend command repeatedly can cause stutters on some systems. When enabled,
this synchronization is paused during fullscreen or borderless windows by
default.

The order of both panel indicators can also be configured from preferences.

The extension can also show CPU info in a separate panel label:

- `temperature | frequency`
- `temperature`
- `frequency`

The CPU info label can be placed on the left, center, or right side of the panel,
with a configurable horizontal margin. When CPU info is hidden, no CPU info is
read from the system.

## Supported profile backends

The extension automatically uses one of two supported profile backends:

- `tuned-adm`, as used on Fedora in the original target setup;
- `powerprofilesctl`, as used by Power Profiles Daemon on systems such as Ubuntu.
