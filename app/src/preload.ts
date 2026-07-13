// Preload: expose a typed, minimal KbApi to the renderer via contextBridge.
import { contextBridge, ipcRenderer } from 'electron';
import type { KbApi } from './kb/types';

const kbApi: KbApi = {
  getAppVersion: () => ipcRenderer.invoke('kb:getAppVersion'), // SPEC-0055 RELEASE-6
  getState: () => ipcRenderer.invoke('kb:getState'),
  pickFolder: () => ipcRenderer.invoke('kb:pickFolder'),
  inspect: (p) => ipcRenderer.invoke('kb:inspect', p),
  create: (opts) => ipcRenderer.invoke('kb:create', opts),
  probeVaultAccess: (vaultPath) => ipcRenderer.invoke('kb:probeVaultAccess', vaultPath),
  openSystemSettingsPrivacy: () => ipcRenderer.invoke('kb:openSystemSettingsPrivacy'),
  capture: (req) => ipcRenderer.invoke('kb:capture', req),
  quickCapture: (req) => ipcRenderer.invoke('kb:quickCapture', req),
  quickCaptureClose: () => ipcRenderer.invoke('kb:quickCaptureClose'),
  quickCaptureContext: () => ipcRenderer.invoke('kb:quickCaptureContext'),
  openAccessibilitySettings: () => ipcRenderer.invoke('kb:openAccessibilitySettings'),
  quickCaptureScreenshot: (mode) => ipcRenderer.invoke('kb:quickCaptureScreenshot', mode),
  openScreenRecordingSettings: () => ipcRenderer.invoke('kb:openScreenRecordingSettings'),
  pipelineStatus: () => ipcRenderer.invoke('kb:pipelineStatus'),
  pipelineStatusView: () => ipcRenderer.invoke('kb:pipelineStatusView'),
  reportRendererError: (report) => ipcRenderer.invoke('kb:reportRendererError', report), // OBS-18 (renderer)
  listReviews: () => ipcRenderer.invoke('kb:listReviews'),
  reviewProjection: () => ipcRenderer.invoke('kb:reviewProjection'), // SHELL-12: queue + freshness envelope
  answerReview: (req) => ipcRenderer.invoke('kb:answerReview', req),
  pipelineControl: (req) => ipcRenderer.invoke('kb:pipelineControl', req),
  fullReplay: () => ipcRenderer.invoke('kb:fullReplay'),
  composeBacklog: () => ipcRenderer.invoke('kb:composeBacklog'),
  composeBacklogStatus: () => ipcRenderer.invoke('kb:composeBacklogStatus'),
  quiesce: () => ipcRenderer.invoke('kb:quiesce'),
  resume: () => ipcRenderer.invoke('kb:resume'),
  quiesceStatus: () => ipcRenderer.invoke('kb:quiesceStatus'),
  ask: (req) => ipcRenderer.invoke('kb:ask', req),
  // #514: live tool-call progress pushed from main during an in-flight kb:ask. A thin `.on` wrapper —
  // the ONLY push-style channel in this app (everything else is poll-based); scoped narrowly to this
  // one event rather than a generic subscribe framework.
  onAskProgress: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, evt: import('./kb/types').AskProgressEvent): void => cb(evt);
    ipcRenderer.on('kb:askProgress', handler);
    return () => ipcRenderer.removeListener('kb:askProgress', handler);
  },
  saveRecallOutput: (result) => ipcRenderer.invoke('kb:saveRecallOutput', result),
  saveConversation: (req) => ipcRenderer.invoke('kb:saveConversation', req), // SPEC-0060 VUX-11 past-chats
  listConversations: () => ipcRenderer.invoke('kb:listConversations'),
  loadConversation: (id) => ipcRenderer.invoke('kb:loadConversation', id),
  deleteConversation: (id) => ipcRenderer.invoke('kb:deleteConversation', id),
  openCitation: (ref) => ipcRenderer.invoke('kb:openCitation', ref),
  openSourceRef: (ref) => ipcRenderer.invoke('kb:openSourceRef', ref),
  listJobs: () => ipcRenderer.invoke('kb:listJobs'),
  setJobConfig: (patch) => ipcRenderer.invoke('kb:setJobConfig', patch),
  runJobNow: (id) => ipcRenderer.invoke('kb:runJobNow', id),
  jobHistory: (id) => ipcRenderer.invoke('kb:jobHistory', id),
  activityFeed: (filter) => ipcRenderer.invoke('kb:activityFeed', filter),
  activityEvents: (filter) => ipcRenderer.invoke('kb:activityEvents', filter),
  activityLineage: (id) => ipcRenderer.invoke('kb:activityLineage', id),
  getInstanceSettings: () => ipcRenderer.invoke('kb:getInstanceSettings'),
  setInstanceSettings: (settings) => ipcRenderer.invoke('kb:setInstanceSettings', settings),
  getScaleRuntime: () => ipcRenderer.invoke('kb:getScaleRuntime'),
  listAgents: () => ipcRenderer.invoke('kb:listAgents'),
  getModelCatalog: () => ipcRenderer.invoke('kb:getModelCatalog'),
  setModel: (id) => ipcRenderer.invoke('kb:setModel', id),
  setAgentModel: (agentKey, id) => ipcRenderer.invoke('kb:setAgentModel', agentKey, id),
  listResearchers: () => ipcRenderer.invoke('kb:listResearchers'),
  setResearcherConfig: (patch) => ipcRenderer.invoke('kb:setResearcherConfig', patch),
  removeResearcher: (id) => ipcRenderer.invoke('kb:removeResearcher', id),
  runResearcherNow: (id) => ipcRenderer.invoke('kb:runResearcherNow', id),
  listResearcherRuns: (id) => ipcRenderer.invoke('kb:listResearcherRuns', id),
  workIqStatus: () => ipcRenderer.invoke('kb:workIqStatus'),
  installWorkIq: () => ipcRenderer.invoke('kb:installWorkIq'),
  listWatchFolders: () => ipcRenderer.invoke('kb:listWatchFolders'),
  setWatchFolder: (patch) => ipcRenderer.invoke('kb:setWatchFolder', patch),
  removeWatchFolder: (id) => ipcRenderer.invoke('kb:removeWatchFolder', id),
  listIntakeConnectors: () => ipcRenderer.invoke('kb:listIntakeConnectors'),
  setIntakeConnectorConfig: (patch) => ipcRenderer.invoke('kb:setIntakeConnectorConfig', patch),
  removeIntakeConnector: (id) => ipcRenderer.invoke('kb:removeIntakeConnector', id),
  runIntakeConnectorNow: (id) => ipcRenderer.invoke('kb:runIntakeConnectorNow', id),
  setSourceSensitivity: (sourceId, label) => ipcRenderer.invoke('kb:setSourceSensitivity', sourceId, label),
  getSourceSensitivities: (sourceIds) => ipcRenderer.invoke('kb:getSourceSensitivities', sourceIds),
  exploreEntities: () => ipcRenderer.invoke('kb:exploreEntities'),
  exploreNeighborhood: (focus) => ipcRenderer.invoke('kb:exploreNeighborhood', focus),
  exploreProjection: (focus) => ipcRenderer.invoke('kb:exploreProjection', focus), // SPEC-0058 STATE-2
  healthReport: () => ipcRenderer.invoke('kb:healthReport'),
  healthRemediate: (req) => ipcRenderer.invoke('kb:healthRemediate', req), // SPEC-0060 VUX-16
  dismissHealthFinding: (req) => ipcRenderer.invoke('kb:dismissHealthFinding', req),
  getTodayProjection: () => ipcRenderer.invoke('kb:getTodayProjection'), // SPEC-0058 Today (instant, maintained)
  // SPEC-0058 STATE-8 (#510): subscribe to the main→renderer projection-changed PUSH. Unlike every other
  // `kbApi` member (request/response `invoke`), this is a subscription — returns an unsubscribe fn so a
  // view's `hide()` can cleanly stop listening (no leaked `ipcRenderer` listener across a view switch).
  onProjectionChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { store: string; builtAt: string }): void => cb(payload);
    ipcRenderer.on('kb:projection-changed', listener);
    return () => ipcRenderer.removeListener('kb:projection-changed', listener);
  },
  // #512: the kept-alive qcap sheet's reset signal on re-summon (see kb/types.ts for why).
  onQuickCaptureResummoned: (cb) => {
    const listener = (): void => cb();
    ipcRenderer.on('kb:qcap-resummoned', listener);
    return () => ipcRenderer.removeListener('kb:qcap-resummoned', listener);
  },
};

contextBridge.exposeInMainWorld('kbApi', kbApi);
