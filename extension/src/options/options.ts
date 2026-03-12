import './options.css';

const i18n = (key: string, subs?: string | string[]): string => chrome.i18n.getMessage(key, subs) || key;

function applyStaticTexts(): void {
  document.getElementById('title')!.textContent = i18n('optionsTitle');
  document.getElementById('status-heading')!.textContent = i18n('statusHeading');
  document.getElementById('daemon-settings-heading')!.textContent = i18n('daemonSettingsHeading');
  document.getElementById('ext-settings-heading')!.textContent = i18n('extSettingsHeading');
  document.getElementById('dt-state')!.textContent = i18n('statusStateLabel');
  document.getElementById('dt-pid')!.textContent = i18n('statusPidLabel');
  document.getElementById('dt-version')!.textContent = i18n('statusVersionLabel');
  document.getElementById('dt-uptime')!.textContent = i18n('statusUptimeLabel');
  document.getElementById('dt-port')!.textContent = i18n('statusPortLabel');
  document.getElementById('dt-ext')!.textContent = i18n('statusExtLabel');
  document.getElementById('dt-sessions')!.textContent = i18n('statusSessionsLabel');
  document.getElementById('port-label')!.textContent = i18n('configPortLabel');
  document.getElementById('log-days-label')!.textContent = i18n('configLogDaysLabel');
  document.getElementById('tool-timeout-label')!.textContent = i18n('configToolTimeoutLabel');
  (document.getElementById('btn-save-config') as HTMLButtonElement).textContent = i18n('saveButton');
  (document.getElementById('btn-restart') as HTMLButtonElement).textContent = i18n('restartButton');
  document.getElementById('reconcile-label')!.textContent = i18n('reconcileLabel');
  document.getElementById('reconcile-30')!.textContent = i18n('reconcile30');
  document.getElementById('reconcile-60')!.textContent = i18n('reconcile60');
  document.getElementById('reconcile-off')!.textContent = i18n('reconcileOff');
  document.getElementById('version-footer')!.textContent = i18n('versionFooter', chrome.runtime.getManifest().version);
}

applyStaticTexts();
