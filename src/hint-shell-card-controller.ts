/**
 * The settings page's staged form over this plugin's own Host entry.
 *
 * Structure follows the official shell executor's page: a controller owns one
 * {@link SettingsFormModel} over the entry's shared configuration form, and the
 * page's slot entry injects a snapshot store plus the model's actions. That is
 * what lets the page stage the field and write it in one fenced save instead of
 * one write per keystroke.
 *
 * The page edits one field. A `!` line becomes an ordinary tool call, so the
 * deadline and the output cap are inherited from the official shell executor
 * and are not re-exposed here; only the command-length cap is this plugin's own
 * decision, and a second surface for a number that already has one is how the
 * two drift apart.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import {
  SettingsFormModel,
  settingsNumberField,
  type SettingsFieldState,
  type SettingsFormActions,
  type SettingsFormScope,
  type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives';

/** The configuration section this page edits. A subset of the served schema by design. */
export interface HintShellSettings {
  /** Longest accepted command line, in characters. */
  maxCommandChars?: number;
}

/** What the page renders: the frame's state plus one state per control. */
export interface HintShellCardState extends SettingsFormShell {
  /** Longest accepted command line, in characters. */
  maxCommandChars: SettingsFieldState;
}

/** The registration-side face the page's slot entry injects. */
export interface HintShellCardFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as `useHintShellCard`. */
    hintShellCard: SnapshotStore<HintShellCardState>;
  };
}

/** Bridges this plugin's Host entry onto the page's staged form. */
export class HintShellCardController {
  private readonly form: SettingsFormModel<HintShellSettings>;
  private readonly store: SnapshotStore<HintShellCardState>;

  /** @param scope - the shared configuration form of this plugin's Host entry. */
  constructor(scope: SettingsFormScope<HintShellSettings>) {
    this.form = new SettingsFormModel(scope, [settingsNumberField('maxCommandChars')]);
    this.store = this.form.bind(() => this.projection());
  }

  /**
   * Project the form onto the page's state.
   *
   * @returns the frame's state plus the control's state.
   */
  private projection(): HintShellCardState {
    return {
      ...this.form.shell(),
      maxCommandChars: this.form.field('maxCommandChars'),
    };
  }

  /**
   * Build the face the page's slot registration injects.
   *
   * @returns the page's snapshot and the form's own actions.
   */
  inject(): HintShellCardFace {
    return { hooks: { hintShellCard: this.store }, ...this.form.actions() };
  }

  /** Release the form subscription. */
  dispose(): void { this.form.dispose(); }
}
