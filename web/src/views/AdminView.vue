<template>
  <div class="admin-root">
    <div v-if="loading" class="center-card compact"><span class="spinner"></span><p>{{ tr('loading') }}</p></div>

    <main v-else-if="screen === 'change-password'" class="login-page">
      <section class="login-card">
        <div class="admin-brand centered"><span><Icon name="waveform" :size="24" /></span><div><strong>WebSpeak</strong><small>{{ tr('adminConsole') }}</small></div></div>
        <header><h1>{{ tr('changePasswordTitle') }}</h1><p>{{ tr('changePasswordLead') }}</p></header>
        <form @submit.prevent="changePassword"><div v-if="errorMessage" class="alert error">{{ errorMessage }}</div><label><span>{{ tr('newPassword') }}</span><input v-model="newPassword" type="password" autocomplete="new-password" maxlength="1024" autofocus :placeholder="tr('passwordPlaceholder')" /></label><label><span>{{ tr('confirmPassword') }}</span><input v-model="confirmNewPassword" type="password" autocomplete="new-password" maxlength="1024" /></label><div class="strength"><i :style="{ width: `${passwordStrength}%` }"></i></div><button class="primary-button wide" :disabled="submitting" type="submit"><span v-if="submitting" class="spinner small"></span>{{ tr('savePassword') }}</button></form>
        <p class="security-note">{{ tr('defaultCredentialNotice') }}</p><LanguageSwitcher v-model="language" class="language-link" :menu-label="tr('languageMenu')" @change="persistLanguage" />
      </section>
    </main>

    <main v-else-if="screen === 'login'" class="login-page">
      <section class="login-card">
        <div class="admin-brand centered"><span><Icon name="waveform" :size="24" /></span><div><strong>WebSpeak</strong><small>{{ tr('adminConsole') }}</small></div></div>
        <header><h1>{{ tr('welcomeAdmin') }}</h1><p>{{ tr('loginLead') }}</p></header>
        <form @submit.prevent="login"><div v-if="errorMessage" class="alert error">{{ errorMessage }}</div><label><span>{{ tr('adminUsername') }}</span><input v-model.trim="loginUsername" autocomplete="username" autofocus /></label><label><span>{{ tr('adminPassword') }}</span><input v-model="loginPassword" type="password" autocomplete="current-password" /></label><button class="primary-button wide" :disabled="submitting" type="submit"><span v-if="submitting" class="spinner small"></span>{{ tr('login') }}</button></form>
        <div class="login-actions"><RouterLink to="/" class="home-link"><Icon name="home" :size="15" />{{ tr('backHome') }}</RouterLink><LanguageSwitcher v-model="language" class="language-link" :menu-label="tr('languageMenu')" @change="persistLanguage" /></div>
      </section>
    </main>

    <div v-else class="admin-shell">
      <aside class="admin-sidebar">
        <div class="admin-brand"><span><Icon name="waveform" :size="22" /></span><div><strong>WebSpeak</strong><small>{{ tr('adminConsole') }}</small></div></div>
        <nav><RouterLink to="/admin" exact-active-class="active"><Icon name="activity" :size="18" />{{ tr('overview') }}</RouterLink><RouterLink to="/admin/server" active-class="active"><Icon name="server" :size="18" />{{ tr('server') }}</RouterLink><RouterLink to="/admin/operations" active-class="active"><Icon name="users" :size="18" />{{ tr('operations') }}</RouterLink><RouterLink to="/admin/skins" active-class="active"><Icon name="compass" :size="18" />{{ tr('skinLibrary') }}</RouterLink></nav>
        <div class="sidebar-bottom"><a href="/" target="_blank"><Icon name="share" :size="16" />{{ tr('openGuest') }}</a><button type="button" @click="logout"><Icon name="door" :size="16" />{{ tr('logout') }}</button></div>
      </aside>

      <main class="admin-main">
        <header class="admin-topbar"><div><small>{{ tr('adminConsole') }}</small><h1>{{ currentPageTitle }}</h1></div><div><span class="running-dot"></span>{{ tr('gatewayRunning') }}<button type="button" class="theme-toggle" :title="themeLabel" :aria-label="themeLabel" @click="cycleTheme"><Icon :name="themeIcon" :size="17" /><span>{{ themeLabel }}</span></button><LanguageSwitcher v-model="language" :menu-label="tr('languageMenu')" @change="persistLanguage" /></div></header>

        <div v-if="errorMessage" class="alert error page-alert">{{ errorMessage }}</div>
        <section v-if="route.path === '/admin/server'" class="page-content server-page">
          <div class="page-heading"><div><h2>{{ tr('serverSettings') }}</h2><p>{{ tr('serverSettingsLead') }}</p></div><button class="primary-button" :disabled="submitting" @click="saveServerSettings">{{ submitting ? tr('saving') : tr('saveChanges') }}</button></div>
          <div class="settings-grid">
            <details class="settings-card settings-accordion target-accordion" open>
              <summary class="settings-accordion-header">
                <span class="settings-accordion-heading"><strong>{{ tr('teamSpeakTarget') }}</strong><small>{{ serverForm.address || '—' }} · {{ serverForm.port || '—' }}</small></span>
                <Icon name="chevron-down" :size="18" />
              </summary>
              <div class="settings-accordion-content">
                <div class="target-settings-layout">
                  <div class="target-fields">
                    <label><span>{{ tr('serverAddress') }}</span><input v-model.trim="serverForm.address" :placeholder="tr('serverPlaceholder')" /></label>
                    <label><span>{{ tr('serverPort') }}</span><input v-model.trim="serverForm.port" inputmode="numeric" type="text" maxlength="5" :placeholder="tr('serverPortPlaceholder')" /></label>
                  </div>
                  <div class="password-row">
                    <label><span>{{ tr('serverPassword') }}</span><input v-model="serverForm.serverPassword" type="password" autocomplete="off" :disabled="serverForm.passwordAction !== 'replace'" :placeholder="serverForm.hasPassword ? tr('passwordConfigured') : tr('optionalPassword')" /></label>
                    <div class="password-actions"><button type="button" :class="{ active: serverForm.passwordAction === 'replace' }" @click="serverForm.passwordAction = 'replace'">{{ tr('change') }}</button><button v-if="serverForm.hasPassword" type="button" :class="{ danger: serverForm.passwordAction === 'remove' }" @click="serverForm.passwordAction = 'remove'">{{ tr('remove') }}</button></div>
                  </div>
                  <button class="secondary-button target-test-button" type="button" :disabled="testing" @click="testServerConnection"><span v-if="testing" class="spinner small"></span><Icon v-else name="activity" :size="17" />{{ testing ? tr('testing') : tr('testConnection') }}</button>
                  <div v-if="testResult" :class="['test-result', 'target-test-result', testResult.ok ? 'success' : 'error']"><Icon :name="testResult.ok ? 'check' : 'close'" :size="18" /><div><strong>{{ testResultTitle }}</strong><small>{{ testResultText }}</small></div></div>
                  <div class="target-runtime-block"><h4>{{ tr('runtimeFacts') }}</h4><dl class="target-runtime-facts"><div><dt>{{ tr('lastTest') }}</dt><dd>{{ formatDate(serverForm.lastTestAt) }}</dd></div><div><dt>{{ tr('latency') }}</dt><dd>{{ serverForm.lastTestLatencyMs == null ? '—' : `${serverForm.lastTestLatencyMs} ms` }}</dd></div><div><dt>{{ tr('internalPort') }}</dt><dd>3040</dd></div></dl></div>
                </div>
              </div>
            </details>

            <details class="settings-card settings-accordion">
              <summary class="settings-accordion-header">
                <span class="settings-accordion-heading"><strong>{{ tr('accessAndIdentity') }}</strong><small>{{ serverForm.accessMode === 'fixed' ? tr('fixedMode') : tr('openMode') }} · {{ serverForm.siteName || 'WebSpeak' }}</small></span>
                <Icon name="chevron-down" :size="18" />
              </summary>
              <div class="settings-accordion-content">
                <div class="access-settings-layout">
                  <fieldset class="access-mode-fieldset"><legend>{{ tr('accessMode') }}</legend><label class="choice" :class="{ selected: serverForm.accessMode === 'fixed' }"><input v-model="serverForm.accessMode" type="radio" value="fixed" /><span><strong>{{ tr('fixedMode') }}</strong><small>{{ tr('fixedModeLead') }}</small></span></label><label class="choice" :class="{ selected: serverForm.accessMode === 'open' }"><input v-model="serverForm.accessMode" type="radio" value="open" /><span><strong>{{ tr('openMode') }}</strong><small>{{ tr('openModeLead') }}</small></span></label></fieldset>
                  <div class="site-identity-fields">
                    <label><span>{{ tr('siteName') }}</span><input v-model.trim="serverForm.siteName" maxlength="80" /></label>
                    <div class="welcome-editor"><div class="welcome-editor-heading"><label><span>{{ tr('welcomeLanguage') }}</span><select v-model="welcomeLanguage"><option v-for="option in welcomeLanguageOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label><small>{{ tr('welcomeLanguageHint') }}</small></div><label><span>{{ tr('welcomeText') }} · {{ selectedWelcomeLanguageLabel }}</span><textarea v-model="selectedWelcomeText" maxlength="500" rows="4" :placeholder="selectedWelcomeDefault"></textarea></label><small class="field-help">{{ tr('welcomeFallbackHint') }}</small></div>
                  </div>
                </div>
              </div>
            </details>

            <details class="settings-card settings-accordion advanced-card">
              <summary class="settings-accordion-header">
                <span class="settings-accordion-heading"><strong>{{ tr('advancedSettings') }}</strong><small>{{ tr('advancedSettingsLead') }}</small></span>
                <span class="settings-accordion-statuses"><span class="settings-summary-chip"><i :class="{ active: serverForm.webRtcEnabled }"></i>{{ tr('webrtcSettings') }} · {{ serverForm.webRtcEnabled ? tr('enabledStatus') : tr('disabledStatus') }}</span><span class="settings-summary-chip"><i :class="{ active: serverForm.relayNodes.some((relay) => relay.enabled) }"></i>{{ tr('relaySettings') }} · {{ tr('relayNodeCount', { count: serverForm.relayNodes.length }) }}</span></span>
                <Icon name="chevron-down" :size="18" />
              </summary>
              <div class="settings-accordion-content">
                <div class="advanced-settings-grid">
                  <section class="settings-subsection webrtc-card"><header class="settings-subsection-heading"><div><h4>{{ tr('webrtcSettings') }}</h4><p class="card-help">{{ tr('webrtcLead') }}</p></div></header><label class="choice toggle-choice" :class="{ selected: serverForm.webRtcEnabled }"><input v-model="serverForm.webRtcEnabled" type="checkbox" @change="handleWebRtcToggle" /><span><strong>{{ tr('webrtcEnabled') }}</strong><small>{{ tr('webrtcEnabledLead') }}</small></span></label><div class="webrtc-port-fields"><div class="port-fields-heading"><strong>{{ tr('webrtcPortRange') }}</strong><small>{{ tr('webrtcPortRangeLead') }}</small></div><div class="port-inputs"><label><span>{{ tr('webrtcPortStart') }}</span><input v-model.number="serverForm.webRtcUdpStart" type="number" inputmode="numeric" min="1024" max="65535" :disabled="serverForm.webRtcEnabled" /></label><label><span>{{ tr('webrtcPortEnd') }}</span><input v-model.number="serverForm.webRtcUdpEnd" type="number" inputmode="numeric" min="1024" max="65535" :disabled="serverForm.webRtcEnabled" /></label></div></div><small class="field-help">{{ tr('webrtcApplyHint') }}</small></section>
                  <section class="settings-subsection relay-card"><header class="settings-subsection-heading"><div><h4>{{ tr('relaySettings') }}</h4><p class="card-help">{{ tr('relaySettingsLead') }}</p></div></header><div v-if="!serverForm.relayNodes.length" class="relay-empty">{{ tr('relayNodeEmpty') }}</div><div class="relay-node-list"><div v-for="(relay, index) in serverForm.relayNodes" :key="relay.id" class="relay-node"><div class="relay-node-heading"><label class="relay-enabled"><input v-model="relay.enabled" type="checkbox" /><strong>{{ relay.name || tr('relayUnnamed') }}</strong></label><button class="text-danger" type="button" @click="removeRelayNode(index)">{{ tr('remove') }}</button></div><div class="relay-fields"><label><span>{{ tr('relayName') }}</span><input v-model.trim="relay.name" maxlength="80" :placeholder="tr('relayNamePlaceholder')" /></label><label><span>{{ tr('relayTarget') }}</span><input v-model.trim="relay.target" maxlength="300" :placeholder="tr('relayTargetPlaceholder')" /></label><div class="password-row"><label><span>{{ tr('relayToken') }}</span><input v-model="relay.token" type="password" autocomplete="off" :disabled="relay.tokenAction !== 'replace'" :placeholder="relay.hasToken ? tr('relayTokenConfigured') : tr('relayTokenPlaceholder')" /></label><div class="password-actions"><button type="button" :class="{ active: relay.tokenAction === 'replace' }" @click="relay.tokenAction = 'replace'">{{ tr('change') }}</button><button v-if="relay.hasToken" type="button" :class="{ danger: relay.tokenAction === 'remove' }" @click="relay.tokenAction = 'remove'">{{ tr('remove') }}</button></div></div></div></div></div><button class="secondary-button relay-add" type="button" @click="addRelayNode">{{ tr('relayAdd') }}</button><small class="field-help">{{ tr('relayManagedHint') }}</small></section>
                </div>
              </div>
            </details>
          </div>
        </section>

        <section v-else-if="route.path === '/admin/operations'" class="page-content operations-page">
          <div class="page-heading"><div><h2>{{ tr('operations') }}</h2><p>{{ tr('operationsLead') }}</p></div><button class="secondary-button" :disabled="operationsLoading" @click="loadOperations"><span v-if="operationsLoading" class="spinner small"></span><Icon v-else name="refresh" :size="17" />{{ tr('refresh') }}</button></div>
          <div class="alert info system-notice"><Icon name="info" :size="16" /><span>{{ tr('updateNotice', { version: operations.diagnostics.version || '—' }) }}</span></div>
          <div class="operations-grid operations-primary">
            <article class="operation-card operation-wide"><header><div><h3>{{ tr('sessions') }}</h3><p>{{ tr('sessionsLead') }}</p></div><strong>{{ operations.sessions.length }}</strong></header><div v-if="operations.sessions.length" class="table-wrap"><table><thead><tr><th>{{ tr('nickname') }}</th><th>{{ tr('sessionState') }}</th><th>{{ tr('age') }}</th><th>{{ tr('memberCount') }}</th><th></th></tr></thead><tbody><tr v-for="session in operations.sessions" :key="session.id"><td><strong>{{ session.nickname }}</strong><small>{{ session.target }}</small></td><td><span class="state-pill">{{ sessionStateLabel(session.state) }}</span></td><td>{{ formatAge(session.ageSeconds) }}</td><td>{{ session.memberCount }}</td><td><button class="danger-button" type="button" :disabled="terminatingSession === session.id" @click="terminateSession(session)">{{ terminatingSession === session.id ? tr('terminating') : tr('endSession') }}</button></td></tr></tbody></table></div><div v-else class="operation-empty"><Icon name="users" :size="22" /><span>{{ tr('sessionEmpty') }}</span></div></article>
            <article class="operation-card"><header><div><h3>{{ tr('invites') }}</h3><p>{{ tr('invitesLead') }}</p></div></header><form class="invite-form" @submit.prevent="createInvite"><label><span>{{ tr('inviteChannel') }}</span><input v-model.trim="inviteForm.channel" maxlength="100" :placeholder="tr('inviteChannelPlaceholder')" /></label><div class="invite-form-grid"><label><span>{{ tr('expiresIn') }}</span><input v-model.number="inviteForm.expiresInHours" type="number" min="1" max="720" /></label><label><span>{{ tr('maxUses') }}</span><input v-model.number="inviteForm.maxUses" type="number" min="0" max="10000" /></label></div><small class="field-help">{{ tr('unlimitedUses') }}</small><button class="primary-button" type="submit" :disabled="submitting"><span v-if="submitting" class="spinner small"></span>{{ tr('createInvite') }}</button></form><div v-if="createdInvite" class="generated-invite"><strong>{{ tr('inviteCreated') }}</strong><div class="generated-link"><input :value="createdInvite.link" readonly /><button class="secondary-button" type="button" @click="copyInviteLink">{{ tr('copyLink') }}</button></div><small>{{ tr('inviteSecurity') }}</small></div><div v-if="operations.invites.length" class="invite-list"><div v-for="invite in operations.invites" :key="invite.id" class="invite-row"><div><strong>{{ invite.channel || tr('defaultChannel') }}</strong><small>{{ invite.target }} · {{ formatDate(invite.expiresAt) }}</small></div><div class="invite-row-meta"><span :class="['state-pill', invite.status]">{{ inviteStatusLabel(invite.status) }}</span><span>{{ invite.useCount }}/{{ invite.maxUses || '∞' }}</span><button v-if="invite.status === 'active'" class="text-danger" type="button" @click="revokeInvite(invite)">{{ tr('revoke') }}</button></div></div></div></article>
          </div>
          <div class="operations-grid lower-operations">
            <article class="operation-card diagnostics-card"><header><div><h3>{{ tr('diagnostics') }}</h3><p>{{ tr('diagnosticsLead') }}</p></div><a class="text-link" href="/api/admin/diagnostics/report">{{ tr('downloadReport') }}</a></header><dl class="diagnostic-list"><div><dt>{{ tr('version') }}</dt><dd>{{ operations.diagnostics.version || '—' }}</dd></div><div><dt>{{ tr('runtime') }}</dt><dd>{{ operations.diagnostics.node || '—' }}</dd></div><div><dt>{{ tr('platform') }}</dt><dd>{{ operations.diagnostics.platform || '—' }} / {{ operations.diagnostics.arch || '—' }}</dd></div><div><dt>{{ tr('databaseSchema') }}</dt><dd>v{{ operations.diagnostics.schemaVersion || '—' }}</dd></div><div><dt>{{ tr('createdSessions') }}</dt><dd>{{ operations.diagnostics.createdSessions }}</dd></div></dl><button class="secondary-button" type="button" @click="downloadBackup">{{ tr('exportBackup') }}</button></article>
            <article class="operation-card logs-card"><header><div><h3>{{ tr('logViewer') }}</h3><p>{{ tr('logViewerLead') }}</p></div><span v-if="!operations.logs.available" class="muted-label">{{ tr('logsUnavailable') }}</span></header><div v-if="operations.logs.sessions.length" class="connection-list"><div class="connection-history-heading"><strong>{{ tr('connectionHistory') }}</strong><small>{{ tr('connectionHistoryLead') }}</small></div><div v-for="record in operations.logs.sessions" :key="record.id" class="connection-row"><div class="connection-person"><strong>{{ record.nickname }}</strong><small>{{ record.target }}</small><small class="connection-route">{{ connectionRoute(record) }}</small></div><div class="connection-detail"><span :class="['connection-status', record.status]">{{ connectionStatusLabel(record.status) }}</span><small>{{ record.connectedAt ? tr('connectedAt') : tr('connectionAttemptedAt') }}：{{ formatDate(record.connectedAt || record.startedAt) }}</small><small>{{ tr('duration') }}：{{ formatAge(record.durationSeconds) }}</small><small v-if="record.disconnectedAt">{{ tr('disconnectedAt') }}：{{ formatDate(record.disconnectedAt) }}</small><small v-if="record.reason">{{ tr('failureReason') }}：{{ connectionFailureText(record.reason) }}</small><small v-if="record.failureDetail" class="failure-detail">{{ tr('failureDetail') }}：{{ record.failureDetail }}</small></div></div></div><div v-if="operations.logs.entries.length" class="log-list"><div v-for="(entry, index) in operations.logs.entries" :key="`${entry.timestamp}-${index}`" class="log-row"><span :class="['log-level', entry.level.toLowerCase()]">{{ entry.level }}</span><div><strong>{{ entry.message || '—' }}</strong><small>{{ formatDate(entry.timestamp) }}<template v-if="Object.keys(entry.context).length"> · {{ formatContext(entry.context) }}</template></small></div></div></div><div v-if="!operations.logs.sessions.length && !operations.logs.entries.length" class="operation-empty"><Icon name="activity" :size="22" /><span>{{ tr('noLogs') }}</span></div></article>
            <article class="operation-card audit-card"><header><div><h3>{{ tr('audit') }}</h3><p>{{ tr('auditLead') }}</p></div></header><ul class="event-list"><li v-for="event in operations.audit" :key="`${event.event}-${event.createdAt}`"><span><Icon name="check" :size="14" /></span><div><strong>{{ eventName(event.event) }}</strong><small>{{ formatDate(event.createdAt) }}</small></div></li><li v-if="!operations.audit.length" class="empty-event">{{ tr('auditEmpty') }}</li></ul></article>
          </div>
        </section>

        <section v-else-if="route.path === '/admin/skins'" class="page-content skin-library-page">
          <div class="page-heading"><div><h2>{{ tr('skinLibrary') }}</h2><p>{{ tr('skinLibraryLead') }}</p></div><button class="primary-button" type="button" :disabled="skinUploading" @click="skinFileInput?.click()"><span v-if="skinUploading" class="spinner small"></span><Icon v-else name="share" :size="16" />{{ skinUploading ? tr('skinUploading') : tr('skinUpload') }}</button></div>
          <input ref="skinFileInput" class="skin-file-input" type="file" accept=".wskin,application/zip" @change="onSkinFileChanged" />
          <div class="alert info skin-library-scope"><Icon name="info" :size="16" /><span>{{ tr('skinLibraryScope') }}</span></div>
          <section class="skin-default-control"><div><strong>{{ tr('skinDefault') }}</strong><p>{{ tr('skinDefaultLead') }}</p></div><select v-model="skinDefaultId" :disabled="skinLoading || skinDefaultSaving" :aria-label="tr('skinDefault')" @change="saveSkinDefault"><option v-for="skin in enabledSkinEntries" :key="skin.id" :value="skin.id">{{ skinName(skin) }}</option></select></section>
          <div v-if="skinManagerError" class="alert error" role="alert">{{ skinManagerError }}</div>
          <div v-if="skinManagerNotice" class="alert success" role="status">{{ skinManagerNotice }}</div>
          <div v-if="skinLoading" class="skin-library-loading"><span class="spinner"></span>{{ tr('loading') }}</div>
          <div v-else-if="skinEntries.length" class="skin-library-grid">
            <article v-for="skin in skinEntries" :key="skin.id" class="skin-library-card">
              <div class="skin-preview" :class="`skin-preview--${skin.previewKind || 'custom'}`"><img v-if="skin.previewUrl" :src="skin.previewUrl" :alt="skinName(skin)" /><span v-else><Icon :name="skin.previewKind === 'night' ? 'moon' : 'sun'" :size="28" /></span><small>v{{ skin.version }}</small><b v-if="skin.builtIn" class="skin-builtin-badge">{{ tr('skinBuiltin') }}</b></div>
              <div class="skin-library-copy"><div class="skin-library-title"><h3>{{ skinName(skin) }}</h3><span>{{ skin.id }}</span></div><p v-if="skinDescription(skin)">{{ skinDescription(skin) }}</p><dl><div><dt>{{ tr('skinAuthor') }}</dt><dd>{{ skin.author }}</dd></div><div><dt>{{ tr('skinLicense') }}</dt><dd>{{ skin.license }}</dd></div><div><dt>{{ tr('skinMinVersion') }}</dt><dd>{{ skin.minAppVersion }}</dd></div></dl><div class="skin-library-actions"><a v-if="skin.previewUrl" :href="skin.previewUrl" target="_blank" rel="noreferrer" class="text-link">{{ tr('skinPreview') }}</a><label v-if="!skin.builtIn" class="skin-enabled-control"><span>{{ skin.enabled === false ? tr('skinDisabled') : tr('skinEnabled') }}</span><input type="checkbox" :checked="skin.enabled !== false" :disabled="updatingSkinId === skin.id" @change="toggleSkinEnabled(skin)" /></label><span v-else class="skin-protected-label">{{ tr('skinProtected') }}</span><button v-if="!skin.builtIn" class="text-danger" type="button" :disabled="removingSkinId === skin.id" @click="removeSkin(skin)">{{ removingSkinId === skin.id ? tr('skinRemoving') : tr('skinRemove') }}</button></div></div>
            </article>
          </div>
          <div v-else class="skin-library-empty"><span><Icon name="compass" :size="24" /></span><strong>{{ tr('skinEmpty') }}</strong><p>{{ tr('skinEmptyLead') }}</p></div>
        </section>

        <section v-else class="page-content overview-page">
          <div v-if="overview.legacyConfigImported" class="alert info import-notice"><span>{{ tr('legacyImported') }}</span><button type="button" @click="dismissLegacyNotice">{{ tr('gotIt') }}</button></div>
          <div class="hero-status"><div><small>{{ tr('systemStatus') }}</small><h2>{{ tr('everythingRunning') }}</h2><p>{{ tr('overviewLead') }}</p></div><span class="status-badge"><i></i>{{ tr('running') }}</span></div>
          <div class="metric-grid"><article><span><Icon name="activity" :size="20" /></span><small>{{ tr('gateway') }}</small><strong>{{ overview.gateway.version || '—' }}</strong><em>{{ formatUptime(overview.gateway.uptimeSeconds) }}</em></article><article><span><Icon name="server" :size="20" /></span><small>{{ tr('teamSpeakTarget') }}</small><strong>{{ overview.teamSpeak.target || '—' }}</strong><em>{{ targetStatusText }}</em></article><article><span><Icon name="users" :size="20" /></span><small>{{ tr('activeSessions') }}</small><strong>{{ overview.sessions.active }} / {{ overview.sessions.limit }}</strong><em>{{ tr('peakSessions', { count: overview.sessions.peak }) }}</em></article></div>
          <div class="overview-columns"><article class="overview-card target-health-card"><header><div><h3>{{ tr('targetHealth') }}</h3><p>{{ tr('targetHealthLead') }}</p></div><RouterLink to="/admin/server">{{ tr('manage') }}</RouterLink></header><dl><div><dt>{{ tr('status') }}</dt><dd><i :class="overview.teamSpeak.status"></i>{{ targetStatusText }}</dd></div><div><dt>{{ tr('lastTest') }}</dt><dd>{{ formatDate(overview.teamSpeak.lastTestAt) }}</dd></div><div><dt>{{ tr('latency') }}</dt><dd>{{ overview.teamSpeak.latencyMs == null ? '—' : `${overview.teamSpeak.latencyMs} ms` }}</dd></div></dl></article><article class="overview-card recent-events-card"><header><div><h3>{{ tr('recentEvents') }}</h3><p>{{ tr('recentEventsLead') }}</p></div></header><ul class="event-list"><li v-for="event in overview.recentEvents" :key="`${event.event}-${event.createdAt}`"><span><Icon name="check" :size="14" /></span><div><strong>{{ eventName(event.event) }}</strong><small>{{ formatDate(event.createdAt) }}</small></div></li><li v-if="!overview.recentEvents.length" class="empty-event">{{ tr('noRecentEvents') }}</li></ul></article></div>
        </section>
        <div v-if="webrtcPortNoticeOpen" class="modal-backdrop" @click.self="webrtcPortNoticeOpen = false"><section class="modal-card" role="dialog" aria-modal="true" :aria-label="tr('webrtcPortNoticeTitle')"><div class="modal-icon"><Icon name="info" :size="21" /></div><h2>{{ tr('webrtcPortNoticeTitle') }}</h2><p>{{ tr('webrtcPortNotice', { range: webrtcPortRangeText }) }}</p><button class="primary-button wide" type="button" @click="webrtcPortNoticeOpen = false">{{ tr('gotIt') }}</button></section></div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { createAdminApi, type AdminApiError as ApiError } from "../services/admin-api.js";
import type { AdminSettings, AdminSession, ManagedInvite, AdminLog, AdminConnectionRecord } from "../../../src/shared/admin-responses.js";
import { copy, germanCopy, russianCopy, japaneseCopy } from "../i18n/admin.js";
import { RouterLink, useRoute, useRouter } from "vue-router";
import Icon from "../components/Icon.vue";
import LanguageSwitcher from "../components/LanguageSwitcher.vue";
import { combineTeamSpeakTarget, splitTeamSpeakTarget } from "../services/teamspeak-target.js";
import { BUILTIN_SKIN_CATALOG, type SkinCatalogEntry } from "../services/skin-catalog.js";
import { applyTheme, getStoredTheme, isDarkTheme, nextTheme, saveTheme, type ThemeMode } from "../services/theme.js";

type Language = "zh" | "en" | "de" | "ru" | "ja";
type Screen = "login" | "change-password" | "admin";
type AccessMode = "fixed" | "open";
interface ProbeState { ok: boolean; checkType?: "network" | "protocol"; passwordVerified?: boolean; latencyMs?: number; serverName?: string | null; packetLossPercent?: number; attempts?: number; successfulAttempts?: number; code?: string; errorCode?: string }
interface RelayNodeForm { id: string; name: string; enabled: boolean; target: string; token: string; tokenAction: "keep" | "replace" | "remove"; hasToken: boolean }
type WelcomeLanguage = "zh" | "en" | "de" | "ru" | "ja";
type WelcomeTextField = "welcomeText" | "welcomeTextEn" | "welcomeTextDe" | "welcomeTextRu" | "welcomeTextJa";

const DEFAULT_WELCOME_TEXTS: Record<WelcomeLanguage, string> = {
  zh: "无需安装 TeamSpeak 客户端，打开浏览器即可加入语音频道。低延迟、轻量、专注于每一次对话。",
  en: "No TeamSpeak client installation required. Open your browser and join a voice channel with low-latency audio built for conversation.",
  de: "Keine Installation des TeamSpeak-Clients nötig. Öffne den Browser und tritt einem Sprachkanal bei – leichtgewichtig und mit geringer Latenz.",
  ru: "Устанавливать клиент TeamSpeak не нужно: откройте браузер и присоединитесь к голосовому каналу. Низкая задержка и удобное общение в каждом разговоре.",
  ja: "TeamSpeak クライアントのインストールは不要です。ブラウザを開くだけで音声チャンネルに参加できます。低遅延で軽快な会話を楽しめます。",
};

const route = useRoute();
const router = useRouter();
const storedLanguage = localStorage.getItem("webspeak:language");
const language = ref<Language>(storedLanguage === "en" || storedLanguage === "de" || storedLanguage === "ru" || storedLanguage === "ja" ? storedLanguage : typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ru") ? "ru" : typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ja") ? "ja" : "zh");
const themeMode = ref<ThemeMode>(getStoredTheme());
const themeIcon = computed(() => isDarkTheme(themeMode.value) ? "sun" : "moon");
const themeLabel = computed(() => isDarkTheme(themeMode.value) ? tr("switchToLightTheme") : tr("switchToDarkTheme"));
applyTheme(themeMode.value);
const loading = ref(true);
const screen = ref<Screen>("login");
const csrfToken = ref("");
const adminApi = createAdminApi({
  csrfToken: () => csrfToken.value,
  onUnauthorized: () => {
    csrfToken.value = "";
    if (screen.value !== "login") { screen.value = "login"; void router.replace("/admin/login"); }
  },
});
const submitting = ref(false);
const testing = ref(false);
const errorMessage = ref("");
const loginUsername = ref("admin");
const loginPassword = ref("");
const newPassword = ref("");
const confirmNewPassword = ref("");
const testResult = ref<ProbeState | null>(null);

const serverForm = reactive({ address: "", port: "9987", serverPassword: "", passwordAction: "keep" as "keep" | "replace" | "remove", hasPassword: false, accessMode: "fixed" as AccessMode, siteName: "WebSpeak", welcomeText: "", welcomeTextEn: "", welcomeTextDe: "", welcomeTextRu: "", welcomeTextJa: "", welcomeDefaults: { ...DEFAULT_WELCOME_TEXTS }, webRtcEnabled: false, webRtcUdpStart: 40000, webRtcUdpEnd: 40099, relayConfigured: false, relayEnabled: false, relayName: "", relayTarget: "", relayToken: "", relayTokenAction: "keep" as "keep" | "replace" | "remove", hasRelayToken: false, relaySettingsTouched: false, relayNodes: [] as RelayNodeForm[], lastTestAt: null as string | null, lastTestLatencyMs: null as number | null });
const welcomeLanguage = ref<WelcomeLanguage>("zh");
const overview = reactive({ gateway: { version: "", uptimeSeconds: 0 }, teamSpeak: { target: "", status: "unknown", lastTestAt: null as string | null, latencyMs: null as number | null }, sessions: { active: 0, peak: 0, limit: 100 }, recentEvents: [] as Array<{ event: string; createdAt: string }>, legacyConfigImported: false });
const operationsLoading = ref(false);
const terminatingSession = ref("");
const skinFileInput = ref<HTMLInputElement | null>(null);
const skinEntries = ref<SkinCatalogEntry[]>([]);
const skinLoading = ref(false);
const skinUploading = ref(false);
const removingSkinId = ref("");
const updatingSkinId = ref("");
const skinDefaultId = ref("builtin.light");
const skinDefaultSaving = ref(false);
const enabledSkinEntries = computed(() => skinEntries.value.filter((skin) => skin.builtIn || skin.enabled !== false));
const skinManagerError = ref("");
const skinManagerNotice = ref("");
const inviteForm = reactive({ channel: "", expiresInHours: 24, maxUses: 0 });
const createdInvite = ref<{ token: string; link: string } | null>(null);
const webrtcPortNoticeOpen = ref(false);
const operations = reactive({ sessions: [] as AdminSession[], invites: [] as ManagedInvite[], diagnostics: { version: "", node: "", platform: "", arch: "", schemaVersion: 0, createdSessions: 0 }, logs: { available: false, entries: [] as AdminLog[], sessions: [] as AdminConnectionRecord[] }, audit: [] as Array<{ event: string; createdAt: string }> });

const welcomeLanguageOptions: Array<{ value: WelcomeLanguage; label: string }> = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
  { value: "ru", label: "Русский" },
  { value: "ja", label: "日本語" },
];

const welcomeTextFieldByLanguage: Record<WelcomeLanguage, WelcomeTextField> = {
  zh: "welcomeText",
  en: "welcomeTextEn",
  de: "welcomeTextDe",
  ru: "welcomeTextRu",
  ja: "welcomeTextJa",
};

const selectedWelcomeText = computed<string>({
  get: () => serverForm[welcomeTextFieldByLanguage[welcomeLanguage.value]],
  set: (value: string) => { serverForm[welcomeTextFieldByLanguage[welcomeLanguage.value]] = value; },
});
const selectedWelcomeLanguageLabel = computed(() => welcomeLanguageOptions.find((option) => option.value === welcomeLanguage.value)?.label ?? "");
const selectedWelcomeDefault = computed(() => serverForm.welcomeDefaults[welcomeLanguage.value] || DEFAULT_WELCOME_TEXTS[welcomeLanguage.value]);

function tr(key: keyof typeof copy.zh, vars: Record<string, string | number> = {}): string { let value: string = language.value === "zh" ? copy.zh[key] : language.value === "de" ? germanCopy[key] ?? copy.en[key] ?? copy.zh[key] : language.value === "ru" ? russianCopy[key] ?? copy.en[key] ?? copy.zh[key] : language.value === "ja" ? japaneseCopy[key] ?? copy.en[key] ?? copy.zh[key] : copy.en[key] ?? copy.zh[key]; for (const [name, replacement] of Object.entries(vars)) value = value.replaceAll(`{{${name}}}`, String(replacement)); return value; }
const passwordStrength = computed(() => Math.min(100, Math.max(8, newPassword.value.length * 5 + (/[\s\W]/.test(newPassword.value) ? 15 : 0))));
const currentPageTitle = computed(() => route.path === "/admin/server" ? tr('server') : route.path === "/admin/operations" ? tr('operations') : route.path === "/admin/skins" ? tr('skinLibrary') : tr('overview'));
const testResultTitle = computed(() => {
  const result = testResult.value;
  if (!result) return "";
  if (result.ok) return result.checkType === "network" ? tr("networkReachable") : tr("connectionReady");
  const names: Record<string, keyof typeof copy.zh> = {
    INVALID_TARGET: "serverAddress",
    INVALID_NICKNAME: "invalidNicknameError",
    HOST_NOT_FOUND: "hostNotFoundError",
    UNREACHABLE: "networkUnreachableError",
    CONNECTION_REFUSED: "connectionRefusedError",
    CONNECTION_RESET: "connectionResetError",
    TIMEOUT: "networkTimeoutError",
    PASSWORD_REQUIRED: "serverPasswordRequiredError",
    INVALID_PASSWORD: "invalidServerPasswordError",
    PROTOCOL_NEGOTIATION_FAILED: "protocolFailureError",
    SERVER_REJECTED: "serverRejectedError",
    PING_UNAVAILABLE: "pingUnavailableError",
  };
  return tr(names[result.code ?? result.errorCode ?? ""] ?? "connectionFailed");
});
const testResultText = computed(() => { if (!testResult.value) return ""; const result = testResult.value; const toolUnavailable = result.errorCode === "PING_UNAVAILABLE"; const loss = toolUnavailable || result.packetLossPercent == null ? null : `${tr('packetLoss')} ${result.packetLossPercent}%`; if (!result.ok) return [connectionFailureText(result.code ?? result.errorCode), loss].filter(Boolean).join(" · "); if (result.checkType === "network") return [tr("networkReachableHint"), result.latencyMs == null ? null : `${result.latencyMs} ms`, loss].filter(Boolean).join(" · "); return [result.serverName, result.latencyMs == null ? null : `${result.latencyMs} ms`, loss].filter(Boolean).join(" · "); });
const targetStatusText = computed(() => overview.teamSpeak.status === "reachable" ? tr('reachable') : overview.teamSpeak.status === "unreachable" ? tr('unreachable') : tr('notTested'));
const webrtcPortRangeText = computed(() => `${serverForm.webRtcUdpStart}–${serverForm.webRtcUdpEnd}`);

onMounted(loadAdminView);
watch(() => [serverForm.address, serverForm.port, serverForm.serverPassword, serverForm.passwordAction], () => { if (!testing.value && screen.value === "admin") testResult.value = null; });
watch(() => route.path, () => { if (screen.value === "admin" && route.path === "/admin/operations") void loadOperations(); else if (screen.value === "admin" && route.path === "/admin/skins") void loadSkinCatalog(); });

async function loadAdminView() { loading.value = true; try { const session = await adminApi.session(); if (!session.authenticated) { screen.value = "login"; if (route.path !== "/admin/login") await router.replace("/admin/login"); } else if (session.mustChangePassword) { csrfToken.value = String(session.csrfToken || ""); screen.value = "change-password"; if (route.path !== "/admin/change-password") await router.replace("/admin/change-password"); } else { csrfToken.value = String(session.csrfToken || ""); screen.value = "admin"; if (route.path === "/admin/login" || route.path === "/admin/change-password") await router.replace("/admin"); await Promise.all([loadOverview(), loadServerSettings()]); if (route.path === "/admin/operations") await loadOperations(); if (route.path === "/admin/skins") await loadSkinCatalog(); } } catch { errorMessage.value = tr('requestFailed'); } finally { loading.value = false; } }
async function login() { submitting.value = true; errorMessage.value = ""; try { const result = await adminApi.login(loginUsername.value, loginPassword.value); csrfToken.value = String(result.csrfToken || ""); loginPassword.value = ""; if (result.mustChangePassword) { screen.value = "change-password"; await router.replace("/admin/change-password"); } else { screen.value = "admin"; await router.replace("/admin"); await Promise.all([loadOverview(), loadServerSettings()]); } } catch (error) { errorMessage.value = errorText((error as ApiError).code); } finally { submitting.value = false; } }
async function changePassword() { errorMessage.value = ""; if (newPassword.value.length < 12) { errorMessage.value = tr('setupPasswordShort'); return; } if (newPassword.value !== confirmNewPassword.value) { errorMessage.value = tr('setupPasswordsMismatch'); return; } submitting.value = true; try { await adminApi.changePassword(newPassword.value); newPassword.value = ""; confirmNewPassword.value = ""; screen.value = "admin"; await router.replace("/admin"); await Promise.all([loadOverview(), loadServerSettings()]); } catch (error) { errorMessage.value = errorText((error as ApiError).code); } finally { submitting.value = false; } }
async function logout() {
  errorMessage.value = "";
  try { await adminApi.logout(); }
  catch (error) { errorMessage.value = errorText((error as ApiError).code); return; }
  csrfToken.value = "";
  screen.value = "login";
  await router.replace("/admin/login");
}
async function loadOverview() { Object.assign(overview, await adminApi.overview()); }
function mapRelayNodes(value: unknown): RelayNodeForm[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const node = item as { id?: unknown; name?: unknown; enabled?: unknown; target?: unknown; hasToken?: unknown };
    if (typeof node.id !== "string" || typeof node.name !== "string" || typeof node.target !== "string") return [];
    return [{ id: node.id, name: node.name, enabled: node.enabled === true, target: node.target, token: "", tokenAction: "keep" as const, hasToken: node.hasToken === true }];
  });
}
function createRelayNode(): RelayNodeForm { return { id: `relay-new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: "", enabled: false, target: "", token: "", tokenAction: "replace", hasToken: false }; }
function addRelayNode() { serverForm.relayNodes.push(createRelayNode()); serverForm.relaySettingsTouched = true; }
function removeRelayNode(index: number) { serverForm.relayNodes.splice(index, 1); serverForm.relaySettingsTouched = true; }
function applyServerSettings(value: AdminSettings) { const target = splitTeamSpeakTarget(value.target); Object.assign(serverForm, value, { address: target.address, port: target.port, serverPassword: "", passwordAction: "keep", welcomeTextDe: String(value.welcomeTextDe || ""), welcomeTextRu: String(value.welcomeTextRu || ""), welcomeTextJa: String(value.welcomeTextJa || ""), welcomeDefaults: { ...DEFAULT_WELCOME_TEXTS, ...(value.welcomeDefaults && typeof value.welcomeDefaults === "object" ? value.welcomeDefaults : {}) }, webRtcEnabled: value.webRtcEnabled === true, webRtcUdpStart: Number(value.webRtcUdpStart || 40000), webRtcUdpEnd: Number(value.webRtcUdpEnd || 40099), relayConfigured: value.relayConfigured === true, relayEnabled: value.relayEnabled === true, relayName: String(value.relayName || ""), relayTarget: String(value.relayTarget || ""), relayToken: "", relayTokenAction: "keep", hasRelayToken: value.hasRelayToken === true, relaySettingsTouched: false, relayNodes: mapRelayNodes(value.relayNodes) }); }
async function loadServerSettings() { applyServerSettings(await adminApi.settings()); }
async function loadOperations() { operationsLoading.value = true; try { const [sessions, invites, diagnostics, logs, audit] = await Promise.all([adminApi.sessions(), adminApi.invites(), adminApi.diagnostics(), adminApi.logs(), adminApi.audit()]); operations.sessions = Array.isArray(sessions.sessions) ? sessions.sessions : []; operations.invites = Array.isArray(invites.invites) ? invites.invites : []; operations.diagnostics = { version: String(diagnostics.gateway?.version || ""), node: String(diagnostics.gateway?.node || ""), platform: String(diagnostics.gateway?.platform || ""), arch: String(diagnostics.gateway?.arch || ""), schemaVersion: Number(diagnostics.database?.schemaVersion || 0), createdSessions: Number(diagnostics.sessions?.created || 0) }; operations.logs = { available: Boolean(logs.available), entries: Array.isArray(logs.entries) ? logs.entries : [], sessions: Array.isArray(logs.sessions) ? logs.sessions : [] }; operations.audit = Array.isArray(audit.events) ? audit.events : []; } catch (error) { errorMessage.value = errorText((error as ApiError).code); } finally { operationsLoading.value = false; } }
async function loadSkinCatalog() {
  skinLoading.value = true;
  skinManagerError.value = "";
  try {
    const value = await adminApi.skins();
    const uploaded = Array.isArray(value.skins) ? value.skins as SkinCatalogEntry[] : [];
    const protectedIds = new Set(BUILTIN_SKIN_CATALOG.map((skin) => skin.id));
    skinEntries.value = [...BUILTIN_SKIN_CATALOG, ...uploaded.filter((skin) => !protectedIds.has(skin.id))];
    skinDefaultId.value = typeof value.defaultSkinId === "string" ? value.defaultSkinId : "builtin.light";
  } catch {
    skinManagerError.value = tr("requestFailed");
  } finally {
    skinLoading.value = false;
  }
}
function skinName(skin: SkinCatalogEntry): string {
  if (skin.id === "builtin.light") return tr("skinDay");
  if (skin.id === "builtin.dark") return tr("skinNight");
  if (skin.id === "community.illusia-voice") return tr("skinIllusia");
  return skin.name;
}
function skinDescription(skin: SkinCatalogEntry): string {
  if (skin.id === "builtin.light") return tr("skinDayDescription");
  if (skin.id === "builtin.dark") return tr("skinNightDescription");
  if (skin.id === "community.illusia-voice") return tr("skinIllusiaDescription");
  return skin.description || "";
}
async function saveSkinDefault() {
  skinDefaultSaving.value = true;
  skinManagerError.value = "";
  skinManagerNotice.value = "";
  try {
    const result = await adminApi.setDefaultSkin(skinDefaultId.value);
    skinDefaultId.value = typeof result.defaultSkinId === "string" ? result.defaultSkinId : "builtin.light";
    skinManagerNotice.value = tr("skinDefaultSaved");
  } catch {
    skinManagerError.value = tr("operationFailed");
    await loadSkinCatalog();
  } finally {
    skinDefaultSaving.value = false;
  }
}
async function toggleSkinEnabled(skin: SkinCatalogEntry) {
  updatingSkinId.value = skin.id;
  skinManagerError.value = "";
  skinManagerNotice.value = "";
  try {
    const result = await adminApi.setSkinEnabled(skin.id, skin.enabled === false);
    const updated = result.skin as SkinCatalogEntry | undefined;
    if (updated) Object.assign(skin, updated);
    if (typeof result.defaultSkinId === "string") skinDefaultId.value = result.defaultSkinId;
    skinManagerNotice.value = tr(skin.enabled === false ? "skinDisabledNotice" : "skinEnabledNotice");
  } catch {
    skinManagerError.value = tr("operationFailed");
    await loadSkinCatalog();
  } finally {
    updatingSkinId.value = "";
  }
}
async function onSkinFileChanged(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  skinManagerError.value = "";
  skinManagerNotice.value = "";
  skinUploading.value = true;
  try {
    const result = await adminApi.uploadSkin(file, (id) => !skinEntries.value.some((entry) => entry.id === id) || window.confirm(`${tr("skinReplaceConfirm")}\n${id}`));
    if (!result) return;
    skinManagerNotice.value = tr("skinImported");
    await loadSkinCatalog();
  } catch (error) {
    skinManagerError.value = error instanceof Error ? error.message : tr("operationFailed");
  } finally {
    input.value = "";
    skinUploading.value = false;
  }
}
async function removeSkin(skin: SkinCatalogEntry) {
  if (!window.confirm(`${tr("skinConfirmRemove")}\n${skin.name} (${skin.id})`)) return;
  removingSkinId.value = skin.id;
  skinManagerError.value = "";
  skinManagerNotice.value = "";
  try {
    await adminApi.deleteSkin(skin.id);
    skinManagerNotice.value = tr("skinRemoved");
    await loadSkinCatalog();
  } catch {
    skinManagerError.value = tr("operationFailed");
  } finally {
    removingSkinId.value = "";
  }
}
async function terminateSession(session: AdminSession) { if (!window.confirm(tr('confirmTerminate', { nickname: session.nickname }))) return; terminatingSession.value = session.id; errorMessage.value = ""; try { await adminApi.terminateSession(session.id); await Promise.all([loadOperations(), loadOverview()]); } catch (error) { errorMessage.value = errorText((error as ApiError).code); } finally { terminatingSession.value = ""; } }
async function createInvite() { submitting.value = true; errorMessage.value = ""; createdInvite.value = null; try { const result = await adminApi.createInvite({ channel: inviteForm.channel, expiresInHours: inviteForm.expiresInHours, maxUses: inviteForm.maxUses }); if (typeof result.token !== "string") throw new Error("INVITE_CREATE_FAILED"); createdInvite.value = { token: result.token, link: `${location.origin}/?invite=${encodeURIComponent(result.token)}` }; inviteForm.channel = ""; await loadOperations(); } catch (error) { errorMessage.value = errorText((error as ApiError).code); } finally { submitting.value = false; } }
async function revokeInvite(invite: ManagedInvite) { if (!window.confirm(tr('confirmRevoke'))) return; try { await adminApi.revokeInvite(invite.id); await loadOperations(); } catch (error) { errorMessage.value = errorText((error as ApiError).code); } }
async function copyInviteLink() { if (!createdInvite.value) return; try { await navigator.clipboard.writeText(createdInvite.value.link); showOperationNotice(tr('copiedLink')); } catch { errorMessage.value = tr('operationFailed'); } }
function showOperationNotice(message: string) { errorMessage.value = message; window.setTimeout(() => { if (errorMessage.value === message) errorMessage.value = ""; }, 2200); }
async function downloadBackup() { try { const blob = await adminApi.backup(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `webspeak-backup-${new Date().toISOString().slice(0, 10)}.db`; anchor.click(); URL.revokeObjectURL(url); await loadOperations(); } catch (error) { errorMessage.value = errorText((error as ApiError).code); } }
async function saveServerSettings() { submitting.value = true; errorMessage.value = ""; try { const result = await adminApi.saveSettings(serverPayload()); applyServerSettings(result.settings); await loadOverview(); } catch (error) { errorMessage.value = errorText((error as ApiError).code); } finally { submitting.value = false; } }
function handleWebRtcToggle() { if (serverForm.webRtcEnabled) webrtcPortNoticeOpen.value = true; }
async function testServerConnection() { await runTest({ target: combineTeamSpeakTarget(serverForm.address, serverForm.port), serverPassword: serverForm.passwordAction === "replace" ? serverForm.serverPassword : undefined, passwordAction: serverForm.passwordAction }); if (testResult.value) { await loadOverview(); serverForm.lastTestAt = new Date().toISOString(); serverForm.lastTestLatencyMs = testResult.value.ok ? (testResult.value.latencyMs ?? null) : null; } }
function touchRelaySettings() { serverForm.relaySettingsTouched = true; }
function serverPayload() { return { target: combineTeamSpeakTarget(serverForm.address, serverForm.port), serverPassword: serverForm.passwordAction === "replace" ? serverForm.serverPassword : undefined, passwordAction: serverForm.passwordAction, accessMode: serverForm.accessMode, siteName: serverForm.siteName, welcomeText: serverForm.welcomeText, welcomeTextEn: serverForm.welcomeTextEn, welcomeTextDe: serverForm.welcomeTextDe, welcomeTextRu: serverForm.welcomeTextRu, welcomeTextJa: serverForm.welcomeTextJa, webRtcEnabled: serverForm.webRtcEnabled, webRtcUdpStart: serverForm.webRtcUdpStart, webRtcUdpEnd: serverForm.webRtcUdpEnd, relayNodes: serverForm.relayNodes.map((node) => ({ id: node.id, name: node.name, target: node.target, enabled: node.enabled, tokenAction: node.tokenAction, ...(node.tokenAction === "replace" ? { token: node.token } : {}) })) }; }
async function runTest(body: Parameters<typeof adminApi.probe>[0]) { testing.value = true; errorMessage.value = ""; testResult.value = null; try { testResult.value = await adminApi.probe(body); } catch (error) { testResult.value = { ok: false, code: (error as ApiError).code }; } finally { testing.value = false; } }
async function dismissLegacyNotice() { try { await adminApi.dismissLegacyNotice(); overview.legacyConfigImported = false; } catch (error) { errorMessage.value = errorText((error as ApiError).code); } }
function persistLanguage() { localStorage.setItem("webspeak:language", language.value); }
function cycleTheme() { themeMode.value = nextTheme(themeMode.value); saveTheme(themeMode.value); }
function formatDate(value: string | null) { return value ? new Intl.DateTimeFormat(language.value === "zh" ? "zh-CN" : language.value === "de" ? "de-DE" : language.value === "ru" ? "ru-RU" : language.value === "ja" ? "ja-JP" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—"; }
function formatUptime(seconds: number) { const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); if (language.value === "zh") return `已运行 ${hours} 小时 ${minutes} 分钟`; if (language.value === "de") return `${hours} Std. ${minutes} Min. aktiv`; if (language.value === "ru") return `Работает ${hours} ч ${minutes} мин`; if (language.value === "ja") return `${hours}時間 ${minutes}分 稼働`; return `Up ${hours}h ${minutes}m`; }
function formatAge(seconds: number | null) { if (seconds == null) return "—"; if (seconds < 60) { if (language.value === "zh") return `${seconds} 秒`; if (language.value === "de") return `${seconds} Sek.`; if (language.value === "ru") return `${seconds} с`; if (language.value === "ja") return `${seconds}秒`; return `${seconds}s`; } const minutes = Math.floor(seconds / 60); if (minutes < 60) { if (language.value === "zh") return `${minutes} 分钟`; if (language.value === "de") return `${minutes} Min.`; if (language.value === "ru") return `${minutes} мин`; if (language.value === "ja") return `${minutes}分`; return `${minutes}m`; } const hours = Math.floor(minutes / 60); const rest = minutes % 60; if (language.value === "zh") return `${hours} 小时 ${rest} 分钟`; if (language.value === "de") return `${hours} Std. ${rest} Min.`; if (language.value === "ru") return `${hours} ч ${rest} мин`; if (language.value === "ja") return `${hours}時間 ${rest}分`; return `${hours}h ${rest}m`; }
function connectionStatusLabel(status: AdminConnectionRecord["status"]) { const names: Record<AdminConnectionRecord["status"], keyof typeof copy.zh> = { active: "connectionActive", connecting: "connectionConnecting", disconnected: "connectionDisconnected", failed: "connectionFailed" }; return tr(names[status]); }
function connectionRoute(record: AdminConnectionRecord) {
  const route = tr("connectionFromTo", { ip: record.clientIp || "—", target: record.target || "—" });
  if (!record.relayName && !record.relayTarget) return route;
  const relay = [record.relayName, record.relayTarget].filter(Boolean).join(" · ") || "—";
  return `${route} · ${tr("connectionViaRelay", { relay })}`;
}
function sessionStateLabel(state: string) { const names: Record<string, { zh: string; en: string; de: string }> = { connecting: { zh: "连接中", en: "Connecting", de: "Verbindung wird hergestellt" }, authenticating: { zh: "认证中", en: "Authenticating", de: "Authentifizierung" }, syncing: { zh: "同步中", en: "Syncing", de: "Synchronisierung" }, connected: { zh: "已连接", en: "Connected", de: "Verbunden" }, interrupted: { zh: "已中断", en: "Interrupted", de: "Unterbrochen" }, reconnecting: { zh: "重连中", en: "Reconnecting", de: "Wiederverbindung" }, disconnecting: { zh: "断开中", en: "Disconnecting", de: "Wird getrennt" }, failed: { zh: "失败", en: "Failed", de: "Fehlgeschlagen" }, idle: { zh: "空闲", en: "Idle", de: "Inaktiv" } }; const locale = language.value === "zh" ? "zh" : language.value === "de" ? "de" : "en"; return names[state]?.[locale] ?? state; }
function inviteStatusLabel(status: ManagedInvite["status"]) { const names: Record<ManagedInvite["status"], keyof typeof copy.zh> = { active: "active", expired: "expired", exhausted: "exhausted", revoked: "revoked" }; return tr(names[status]); }
function formatContext(context: Record<string, string | number | boolean>) { return Object.entries(context).map(([key, value]) => `${key}=${value}`).join(" · "); }
function eventName(event: string) { if (event === "ADMIN_LOGIN_FAILED") return language.value === "zh" ? "管理员登录失败" : language.value === "ru" ? "Ошибка входа администратора" : language.value === "ja" ? "管理者ログイン失敗" : language.value === "de" ? "Administrator-Anmeldung fehlgeschlagen" : "Administrator login failed"; if (event === "CONNECTION_TEST_SUCCEEDED") return language.value === "zh" ? "连接测试成功" : language.value === "ru" ? "Проверка подключения успешна" : language.value === "ja" ? "接続テスト成功" : language.value === "de" ? "Verbindungstest erfolgreich" : "Connection test succeeded"; if (event === "CONNECTION_TEST_FAILED") return language.value === "zh" ? "连接测试失败" : language.value === "ru" ? "Проверка подключения не удалась" : language.value === "ja" ? "接続テスト失敗" : language.value === "de" ? "Verbindungstest fehlgeschlagen" : "Connection test failed"; const names: Record<string, keyof typeof copy.zh> = { ADMIN_LOGIN_SUCCEEDED: "loginEvent", ADMIN_LOGOUT: "logoutEvent", SETTINGS_CHANGED: "settingsEvent", ADMIN_INITIALIZED: "initializedEvent", LEGACY_CONFIG_IMPORTED: "importedEvent", CONNECTION_TEST: "testEvent" }; return names[event] ? tr(names[event]) : language.value === "zh" ? "系统事件" : event.replaceAll("_", " "); }
function errorText(code?: string) {
  if (code === "INVALID_PASSWORD") return tr('invalidPassword');
  if (code === "INVALID_ADMIN_PASSWORD") return tr('setupPasswordShort');
  if (code === "PASSWORD_CHANGE_REQUIRED") return tr('changePasswordLead');
  if (code === "RATE_LIMITED") return tr('rateLimited');
  if (code === "INVALID_WEBRTC_PORT_RANGE") {
    if (language.value === "zh") return "WebRTC UDP 端口范围无效，请填写 1024–65535 且起始端口不能大于结束端口。";
    if (language.value === "de") return "Der WebRTC-UDP-Portbereich ist ungültig. Verwende 1024–65535; der Startport darf nicht größer als der Endport sein.";
    if (language.value === "ru") return "Диапазон UDP-портов WebRTC некорректен. Используйте 1024–65535; начальный порт не может быть больше конечного.";
    if (language.value === "ja") return "WebRTC UDP ポート範囲が正しくありません。1024–65535 の範囲で、開始ポートを終了ポート以下にしてください。";
    return "The WebRTC UDP port range is invalid. Use 1024–65535 with the start no greater than the end.";
  }
  if (code === "WEBRTC_PORT_LOCKED") {
    if (language.value === "zh") return "WebRTC 已开启，请先关闭并保存后再修改端口范围。";
    if (language.value === "de") return "WebRTC ist aktiviert. Deaktiviere es und speichere zuerst, bevor du den Portbereich änderst.";
    if (language.value === "ru") return "WebRTC включён. Сначала отключите его и сохраните настройки, затем изменяйте диапазон портов.";
    if (language.value === "ja") return "WebRTC が有効です。ポート範囲を変更する前に無効にして保存してください。";
    return "WebRTC is enabled. Turn it off and save before changing the port range.";
  }
  const locale = language.value === "zh" ? "zh" : language.value === "de" ? "de" : "en";
  const relayErrors: Record<string, { zh: string; en: string; de: string }> = {
    INVALID_RELAY_NAME: { zh: "中继名称无效或为空。", en: "The relay name is invalid or empty.", de: "Der Relay-Name ist ungültig oder leer." },
    INVALID_RELAY_TARGET: { zh: "中继服务器地址无效。", en: "The relay server address is invalid.", de: "Die Relay-Serveradresse ist ungültig." },
    INVALID_RELAY_TOKEN: { zh: "启用中继时必须填写令牌。", en: "A relay token is required when the relay is enabled.", de: "Beim Aktivieren des Relays ist ein Token erforderlich." },
  };
  if (relayErrors[code || ""]) return relayErrors[code || ""][locale];
  const probe: Record<string, { zh: string; en: string; de: string }> = {
    INVALID_TARGET: { zh: "TeamSpeak 服务器地址格式无效。", en: "The TeamSpeak server address is invalid.", de: "Die TeamSpeak-Serveradresse ist ungültig." },
    PING_UNAVAILABLE: { zh: "当前运行环境没有可用的 ICMP Ping 工具。", en: "The runtime does not provide an ICMP ping tool.", de: "In der Laufzeitumgebung ist kein ICMP-Ping-Tool verfügbar." },
    HOST_NOT_FOUND: { zh: "找不到服务器主机名。", en: "The server hostname could not be resolved.", de: "Der Servername konnte nicht aufgelöst werden." },
    UNREACHABLE: { zh: "无法连接 TeamSpeak 服务器。", en: "The TeamSpeak server is unreachable.", de: "Der TeamSpeak-Server ist nicht erreichbar." },
    TIMEOUT: { zh: "连接 TeamSpeak 超时。", en: "The TeamSpeak connection timed out.", de: "Die Verbindung zu TeamSpeak ist abgelaufen." },
    PROTOCOL_NEGOTIATION_FAILED: { zh: "无法识别 TeamSpeak 协议。", en: "TeamSpeak protocol negotiation failed.", de: "Die Aushandlung des TeamSpeak-Protokolls ist fehlgeschlagen." },
    SERVER_REJECTED: { zh: "TeamSpeak 服务器拒绝了连接。", en: "The TeamSpeak server rejected the connection.", de: "Der TeamSpeak-Server hat die Verbindung abgelehnt." },
    TARGET_NOT_ALLOWED: { zh: "此地址不允许在开放模式中使用。", en: "This target is not allowed in open mode.", de: "Dieses Ziel ist im offenen Modus nicht erlaubt." },
  };
  return probe[code || ""]?.[locale] ?? tr('requestFailed');
}

function connectionFailureText(code?: string) {
  const names: Record<string, keyof typeof copy.zh> = {
    PASSWORD_REQUIRED: "serverPasswordRequiredError",
    SERVER_PASSWORD_REQUIRED: "serverPasswordRequiredError",
  INVALID_PASSWORD: "invalidServerPasswordError",
  INVALID_SERVER_PASSWORD: "invalidServerPasswordError",
    INVALID_TARGET: "serverAddress",
    INVALID_NICKNAME: "invalidNicknameError",
  HOST_NOT_FOUND: "hostNotFoundError",
  UNREACHABLE: "networkUnreachableError",
  CONNECTION_REFUSED: "connectionRefusedError",
  CONNECTION_RESET: "connectionResetError",
  TIMEOUT: "networkTimeoutError",
    PROTOCOL_NEGOTIATION_FAILED: "protocolFailureError",
    SERVER_REJECTED: "serverRejectedError",
  PING_UNAVAILABLE: "pingUnavailableError",
  CONNECTION_FAILED: "connectionFailed",
  };
  return names[code || ""] ? tr(names[code || ""]) : errorText(code);
}

</script>

<style scoped src="../styles/admin.css"></style>
