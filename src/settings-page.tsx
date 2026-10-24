/**
 * Assembly of this plugin's settings page.
 *
 * The page is split from `index.ts` for one reason: the hint half must stay
 * importable by a bare TypeScript runtime (its unit test runs the real module
 * with no JSX transform and no React installed), while the page is JSX over the
 * React UI primitives. `index.ts` therefore loads this module lazily through
 * `import()`, and the bundler inlines it into the same single-file client
 * bundle.
 *
 * What this file owns: the staged form controller's lifetime, and the slot
 * entry the Plugins page renders.
 *
 * ── Why `plugins.row.config` and not `plugins.item` ────────────────────────
 *
 * `plugins.item` is the Official group's slot: the page renders one card per
 * entry beside the official bundles. This is a third-party bundle, so its
 * configuration belongs on its own row, under the installed package — that is
 * exactly what `plugins.row.config` is for, keyed `<package name>#<row id>`.
 * Registering into `plugins.item` put the config among the built-in plugins.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type { ClientPluginContext } from './types.ts';
import { HintShellCard } from './HintShellCard.tsx';
import { HintShellCardController, type HintShellSettings } from './hint-shell-card-controller.ts';

/** Services, namespace, and package identity the page binds. */
export interface SettingsPageOptions {
  /** Shared configuration forms, one per Host entry. */
  configForms: ClientPluginContext['configForms'];
  /** Slot registry the Plugins page renders contributed entries through. */
  slots: ClientPluginContext['slots'];
  /** Settings namespace to bind; the profile entry id. */
  namespace: string;
  /** This bundle's package name, the first half of the row config key. */
  packageName: string;
  /** The bundle row id this configuration belongs to, the second half of the key. */
  rowId: string;
}

/**
 * Mount the settings page: one staged form, one row-config entry.
 *
 * @param options - the services the page binds, and its identity
 * @returns a disposer that releases the form and withdraws the entry
 */
export function mountSettingsPage(options: SettingsPageOptions): () => void {
  const { configForms, slots, namespace, packageName, rowId } = options;
  const controller = new HintShellCardController(configForms.get<HintShellSettings>(namespace));
  const disposeEntry = slots.register(
    {
      name: 'plugins.row.config',
      // The page dispatches a keyed slot by exactly this key, so it has to match
      // `rowConfigKey(pkg.name, row.rowId)` or the entry never renders.
      key: `${packageName}#${rowId}`,
      locale: namespace,
      inject: () => controller.inject(),
    },
    HintShellCard,
  );
  return () => {
    disposeEntry();
    controller.dispose();
  };
}
