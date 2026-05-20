import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {PROFILES} from './constants.js';

// Owns the clickable power-profile actor in the shell panel.
export class ProfileIndicator {
    constructor({settings, uuid, name, onCycle}) {
        this._settings = settings;
        this._uuid = uuid;
        this._name = name;
        this._onCycle = onCycle;
        this._currentProfile = null;
        this._create();
    }

    destroy() {
        this._icon?.destroy();
        this._label?.destroy();
        this._indicator?.destroy();
        delete Main.panel.statusArea[this._uuid];
        this._indicator = null;
        this._icon = null;
        this._label = null;
    }

    recreate() {
        // GNOME Shell positions panel actors when they are inserted, so moving
        // an indicator means recreating it at the requested order.
        const currentProfile = this._currentProfile;
        this.destroy();
        this._create();

        if (currentProfile)
            this.updateProfile(currentProfile);
    }

    updateProfile(profile) {
        const profileData = PROFILES.get(profile);

        if (!profileData || !this._icon)
            return;

        this._currentProfile = profile;
        this._icon.icon_name = profileData.icon;
        this.updateAppearance();
    }

    updateAppearance() {
        if (!this._currentProfile || !this._icon || !this._label)
            return;

        const profileData = PROFILES.get(this._currentProfile);

        if (!profileData)
            return;

        if (this._settings.get_boolean('colorize-indicator'))
            this._icon.style = `color: ${profileData.color};`;
        else
            this._icon.style = '';

        this._label.text = _(profileData.label);
        this._label.visible = this._settings.get_boolean('show-profile-label');
    }

    _create() {
        // Profile indicator: one click cycles through available profiles.
        this._indicator = new PanelMenu.Button(0.0, this._name, true);

        const clickGesture = new Clutter.ClickGesture();
        clickGesture.set_recognize_on_press(true);
        clickGesture.connectObject('recognize', () => {
            this._onCycle();
        }, this._indicator);
        this._indicator.add_action(clickGesture);

        this._icon = new St.Icon({
            style_class: 'system-status-icon',
        });

        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'smart-power-profiles-profile-label',
        });

        const indicatorBox = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });
        indicatorBox.add_child(this._icon);
        indicatorBox.add_child(this._label);
        this._indicator.add_child(indicatorBox);

        Main.panel.addToStatusArea(
            this._uuid,
            this._indicator,
            Math.min(this._settings.get_uint('indicator-order'), 16)
        );
        this._settings.bind(
            'show-indicator',
            this._indicator,
            'visible',
            Gio.SettingsBindFlags.DEFAULT
        );
    }
}
