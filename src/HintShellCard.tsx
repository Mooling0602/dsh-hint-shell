/**
 * The plugin's settings page: the one limit it decides for itself.
 *
 * This is the browser half of the configuration surface. The Host owns the
 * schema and the stored values (`src/config.ts`); the page only renders them.
 * The Plugins page owns the frame: it renders this entry as the row's
 * one-liner (`view: 'summary'`) and, on the row's configuration page, as the
 * body (`view: 'page'`).
 *
 * The field is the same primitive the official pages use, so staging, numeric
 * validation, reset-to-default, and the single fenced save behave identically —
 * including the rule that leaving the page drops staged edits.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import { SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { formLabels, type HintLocaleKey } from './locales.ts';
import type { HintShellCardFace } from './hint-shell-card-controller.ts';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy the settings page renders. */
    'dsh-hint-shell': HintLocaleKey;
  }
}

/** Props the renderer binds for this page. */
export type HintShellCardProps =
  & PropsRuntime<'plugins.row.config'>
  & PropsLocale<'dsh-hint-shell'>
  & InjectFace<HintShellCardFace>;

/**
 * Render this plugin's one-liner or its settings form, as the Plugins page asks.
 *
 * @param props - the view asked for, locale copy, and the page's form actions.
 * @returns the one-liner, or the form.
 */
export function HintShellCard(props: HintShellCardProps) {
  const { t } = props;
  const state = props.useHintShellCard(snapshot => snapshot);
  if (props.view === 'summary') return t('description');
  const disabled = !state.writable;
  return (
    <SettingsForm
      labels={formLabels(t)}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <SettingsValueField
        id="plugin-config-hint-shell-command"
        label={t('maxCommandChars')}
        hint={t('maxCommandCharsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        text={state.maxCommandChars.text}
        overridden={state.maxCommandChars.overridden}
        invalid={state.maxCommandChars.invalid}
        onEdit={(text) => { props.edit('maxCommandChars', text); }}
        onReset={() => { props.resetField('maxCommandChars'); }}
      />
    </SettingsForm>
  );
}
