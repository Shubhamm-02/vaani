// Android 11+ hides other apps' packages unless the manifest declares what it needs
// to see. A voice assistant has to open whichever app the user names, so declare
// visibility of launchable apps (MAIN + LAUNCHER) - the narrow form, not the
// QUERY_ALL_PACKAGES permission.
const { withAndroidManifest } = require('expo/config-plugins');

const LAUNCHER_INTENT = {
  action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
  category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
};

module.exports = function withLauncherQueries(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.queries = manifest.queries?.length ? manifest.queries : [{}];
    const q = manifest.queries[0];
    q.intent = q.intent || [];
    const already = q.intent.some(
      (i) => i.action?.[0]?.$?.['android:name'] === 'android.intent.action.MAIN' && i.category?.[0]?.$?.['android:name'] === 'android.intent.category.LAUNCHER',
    );
    if (!already) q.intent.push(LAUNCHER_INTENT);
    return cfg;
  });
};
