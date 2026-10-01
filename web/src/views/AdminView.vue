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
        <div class="sidebar-bottom"><a href="/" target="_blank"><Icon name="share" :size="16" />{{ tr('openGuest') }}</a><button type="button" :disabled="loggingOut" @click="logout"><Icon name="door" :size="16" />{{ tr('logout') }}</button></div>
      </aside>

      <main class="admin-main" :inert="loggingOut || undefined" :aria-busy="loggingOut">
        <header class="admin-topbar">
          <div class="admin-page-title"><small>{{ tr('adminConsole') }}</small><h1>{{ currentPageTitle }}</h1></div>
          <div class="admin-tools">
            <span class="gateway-status" role="status" :title="tr('gatewayRunning')"><span class="running-dot" aria-hidden="true"></span><span class="gateway-status-label">{{ tr('gatewayRunning') }}</span></span>
            <button type="button" class="theme-toggle" :title="themeLabel" :aria-label="themeLabel" @click="cycleTheme"><Icon :name="themeIcon" :size="17" /><span>{{ themeLabel }}</span></button>
            <LanguageSwitcher v-model="language" :menu-label="tr('languageMenu')" @change="persistLanguage" />
          </div>
        </header>

        <div v-if="errorMessage" class="alert error page-alert">{{ errorMessage }}</div>
        <section v-if="route.path === '/admin/server'" class="page-content server-page">
          <div class="page-heading"><div><h2>{{ tr('serverSettings') }}</h2><p>{{ tr('serverSettingsLead') }}</p></div><button class="primary-button" :disabled="serverSaving" @click="saveServerSettings">{{ serverSaving ? tr('saving') : tr('saveChanges') }}</button></div>
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
            <article class="operation-card operation-wide"><header><div><h3>{{ tr('sessions') }}</h3><p>{{ tr('sessionsLead') }}</p></div><strong>{{ operations.sessions.length }}</strong></header><div v-if="operations.sessions.length" class="table-wrap"><table><thead><tr><th>{{ tr('nickname') }}</th><th>{{ tr('sessionState') }}</th><th>{{ tr('age') }}</th><th>{{ tr('memberCount') }}</th><th></th></tr></thead><tbody><tr v-for="session in operations.sessions" :key="session.id"><td><strong>{{ session.nickname }}</strong><small>{{ session.target }}</small></td><td><span class="state-pill">{{ sessionStateLabel(session.state) }}</span></td><td>{{ formatAge(session.ageSeconds) }}</td><td>{{ session.memberCount }}</td><td><button class="danger-button" type="button" :disabled="Boolean(terminatingSession)" @click="terminateSession(session)">{{ terminatingSession === session.id ? tr('terminating') : tr('endSession') }}</button></td></tr></tbody></table></div><div v-else class="operation-empty"><Icon name="users" :size="22" /><span>{{ tr('sessionEmpty') }}</span></div></article>
            <article class="operation-card"><header><div><h3>{{ tr('invites') }}</h3><p>{{ tr('invitesLead') }}</p></div></header><form class="invite-form" @submit.prevent="createInvite"><label><span>{{ tr('inviteChannel') }}</span><input v-model.trim="inviteForm.channel" maxlength="100" :placeholder="tr('inviteChannelPlaceholder')" /></label><div class="invite-form-grid"><label><span>{{ tr('expiresIn') }}</span><input v-model.number="inviteForm.expiresInHours" type="number" min="1" max="720" /></label><label><span>{{ tr('maxUses') }}</span><input v-model.number="inviteForm.maxUses" type="number" min="0" max="10000" /></label></div><small class="field-help">{{ tr('unlimitedUses') }}</small><button class="primary-button" type="submit" :disabled="inviteSubmitting"><span v-if="inviteSubmitting" class="spinner small"></span>{{ tr('createInvite') }}</button></form><div v-if="createdInvite" class="generated-invite"><strong>{{ tr('inviteCreated') }}</strong><div class="generated-link"><input :value="createdInvite.link" readonly /><button class="secondary-button" type="button" @click="copyInviteLink">{{ tr('copyLink') }}</button></div><small>{{ tr('inviteSecurity') }}</small></div><div v-if="operations.invites.length" class="invite-list"><div v-for="invite in operations.invites" :key="invite.id" class="invite-row"><div><strong>{{ invite.channel || tr('defaultChannel') }}</strong><small>{{ invite.target }} · {{ formatDate(invite.expiresAt) }}</small></div><div class="invite-row-meta"><span :class="['state-pill', invite.status]">{{ inviteStatusLabel(invite.status) }}</span><span>{{ invite.useCount }}/{{ invite.maxUses || '∞' }}</span><button v-if="invite.status === 'active'" class="text-danger" type="button" :disabled="revokingInvites.has(invite.id)" @click="revokeInvite(invite)">{{ tr('revoke') }}</button></div></div></div></article>
          </div>
          <div class="operations-grid lower-operations">
            <article class="operation-card diagnostics-card"><header><div><h3>{{ tr('diagnostics') }}</h3><p>{{ tr('diagnosticsLead') }}</p></div><a class="text-link" href="/api/admin/diagnostics/report">{{ tr('downloadReport') }}</a></header><dl class="diagnostic-list"><div><dt>{{ tr('version') }}</dt><dd>{{ operations.diagnostics.version || '—' }}</dd></div><div><dt>{{ tr('runtime') }}</dt><dd>{{ operations.diagnostics.node || '—' }}</dd></div><div><dt>{{ tr('platform') }}</dt><dd>{{ operations.diagnostics.platform || '—' }} / {{ operations.diagnostics.arch || '—' }}</dd></div><div><dt>{{ tr('databaseSchema') }}</dt><dd>v{{ operations.diagnostics.schemaVersion || '—' }}</dd></div><div><dt>{{ tr('createdSessions') }}</dt><dd>{{ operations.diagnostics.createdSessions }}</dd></div></dl><button class="secondary-button" type="button" @click="downloadBackup">{{ tr('exportBackup') }}</button></article>
            <article class="operation-card logs-card"><header><div><h3>{{ tr('logViewer') }}</h3><p>{{ tr('logViewerLead') }}</p></div><span v-if="!operations.logs.available" class="muted-label">{{ tr('logsUnavailable') }}</span></header><div v-if="operations.logs.sessions.length" class="connection-list"><div class="connection-history-heading"><strong>{{ tr('connectionHistory') }}</strong><small>{{ tr('connectionHistoryLead') }}</small></div><div v-for="record in operations.logs.sessions" :key="record.id" class="connection-row"><div class="connection-person"><strong>{{ record.nickname }}</strong><small>{{ record.target }}</small><small class="connection-route">{{ connectionRoute(record) }}</small></div><div class="connection-detail"><span :class="['connection-status', record.status]">{{ connectionStatusLabel(record.status) }}</span><small>{{ record.connectedAt ? tr('connectedAt') : tr('connectionAttemptedAt') }}：{{ formatDate(record.connectedAt || record.startedAt) }}</small><small>{{ tr('duration') }}：{{ formatAge(record.durationSeconds) }}</small><small v-if="record.disconnectedAt">{{ tr('disconnectedAt') }}：{{ formatDate(record.disconnectedAt) }}</small><small v-if="record.reason">{{ tr('failureReason') }}：{{ connectionFailureText(record.reason) }}</small><small v-if="record.failureDetail" class="failure-detail">{{ tr('failureDetail') }}：{{ record.failureDetail }}</small></div></div></div><div v-if="operations.logs.entries.length" class="log-list"><div v-for="(entry, index) in operations.logs.entries" :key="`${entry.timestamp}-${index}`" class="log-row"><span :class="['log-level', entry.level.toLowerCase()]">{{ entry.level }}</span><div><strong>{{ entry.message || '—' }}</strong><small>{{ formatDate(entry.timestamp) }}<template v-if="Object.keys(entry.context).length"> · {{ formatContext(entry.context) }}</template></small></div></div></div><div v-if="!operations.logs.sessions.length && !operations.logs.entries.length" class="operation-empty"><Icon name="activity" :size="22" /><span>{{ tr('noLogs') }}</span></div></article>
            <article class="operation-card audit-card"><header><div><h3>{{ tr('audit') }}</h3><p>{{ tr('auditLead') }}</p></div></header><ul class="event-list"><li v-for="event in operations.audit" :key="`${event.event}-${event.createdAt}`"><span><Icon name="check" :size="14" /></span><div><strong>{{ eventName(event.event) }}</strong><small>{{ formatDate(event.createdAt) }}</small></div></li><li v-if="!operations.audit.length" class="empty-event">{{ tr('auditEmpty') }}</li></ul></article>
          </div>
        </section>

        <section v-else-if="route.path === '/admin/skins'" class="page-content skin-library-page">
          <div class="page-heading"><div><h2>{{ tr('skinLibrary') }}</h2><p>{{ tr('skinLibraryLead') }}</p></div><button class="primary-button" type="button" :disabled="skinBusy" @click="skinFileInput?.click()"><span v-if="skinUploading" class="spinner small"></span><Icon v-else name="share" :size="16" />{{ skinUploading ? tr('skinUploading') : tr('skinUpload') }}</button></div>
          <input ref="skinFileInput" class="skin-file-input" type="file" accept=".wskin,application/zip" @change="onSkinFileChanged" />
          <div class="alert info skin-library-scope"><Icon name="info" :size="16" /><span>{{ tr('skinLibraryScope') }}</span></div>
          <section class="skin-default-control"><div><strong>{{ tr('skinDefault') }}</strong><p>{{ tr('skinDefaultLead') }}</p></div><select v-model="skinDefaultId" :disabled="skinLoading || skinBusy" :aria-label="tr('skinDefault')" @change="saveSkinDefault"><option v-for="skin in enabledSkinEntries" :key="skin.id" :value="skin.id">{{ skinName(skin) }}</option></select></section>
          <div v-if="skinManagerError" class="alert error" role="alert">{{ skinManagerError }}</div>
          <div v-if="skinManagerNotice" class="alert success" role="status">{{ skinManagerNotice }}</div>
          <div v-if="skinLoading" class="skin-library-loading"><span class="spinner"></span>{{ tr('loading') }}</div>
          <div v-else-if="skinEntries.length" class="skin-library-grid">
            <article v-for="skin in skinEntries" :key="skin.id" class="skin-library-card">
              <div class="skin-preview" :class="`skin-preview--${skin.previewKind || 'custom'}`"><img v-if="skin.previewUrl" :src="skin.previewUrl" :alt="skinName(skin)" /><span v-else><Icon :name="skin.previewKind === 'night' ? 'moon' : 'sun'" :size="28" /></span><small>v{{ skin.version }}</small><b v-if="skin.builtIn" class="skin-builtin-badge">{{ tr('skinBuiltin') }}</b></div>
              <div class="skin-library-copy"><div class="skin-library-title"><h3>{{ skinName(skin) }}</h3><span>{{ skin.id }}</span></div><p v-if="skinDescription(skin)">{{ skinDescription(skin) }}</p><dl><div><dt>{{ tr('skinAuthor') }}</dt><dd>{{ skin.author }}</dd></div><div><dt>{{ tr('skinLicense') }}</dt><dd>{{ skin.license }}</dd></div><div><dt>{{ tr('skinMinVersion') }}</dt><dd>{{ skin.minAppVersion }}</dd></div></dl><div class="skin-library-actions"><a v-if="skin.previewUrl" :href="skin.previewUrl" target="_blank" rel="noreferrer" class="text-link">{{ tr('skinPreview') }}</a><label v-if="!skin.builtIn" class="skin-enabled-control"><span>{{ skin.enabled === false ? tr('skinDisabled') : tr('skinEnabled') }}</span><input type="checkbox" :checked="skin.enabled !== false" :disabled="skinBusy" @click.prevent="toggleSkinEnabled(skin)" /></label><span v-else class="skin-protected-label">{{ tr('skinProtected') }}</span><button v-if="!skin.builtIn" class="text-danger" type="button" :disabled="skinBusy" @click="removeSkin(skin)">{{ removingSkinId === skin.id ? tr('skinRemoving') : tr('skinRemove') }}</button></div></div>
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
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { createAdminApi, isAdminRequestCancelled, type AdminApiError as ApiError } from "../services/admin-api.js";
import type { AdminConnectionRecord } from "../../../src/shared/admin-responses.js";
import type { AdminTranslationKey } from "../i18n/admin.js";
import { useAdminI18n } from "../composables/useAdminI18n.js";
import { RouterLink, useRoute, useRouter } from "vue-router";
import Icon from "../components/Icon.vue";
import LanguageSwitcher from "../components/LanguageSwitcher.vue";
import { createAdminRequests } from "../services/admin-requests.js";
import { useAdminServerSettings } from "../composables/useAdminServerSettings.js";
import { useAdminOperations } from "../composables/useAdminOperations.js";
import { useAdminSkins } from "../composables/useAdminSkins.js";
import { DEFAULT_WELCOME_TEXTS, type SiteLanguage } from "../../../src/site-copy.js";
import type { SkinCatalogEntry } from "../services/skin-catalog.js";
import { applyTheme, getStoredTheme, isDarkTheme, nextTheme, saveTheme, type ThemeMode } from "../services/theme.js";

type Screen = "login" | "change-password" | "admin";
type WelcomeLanguage = SiteLanguage;
type WelcomeTextField = "welcomeText" | "welcomeTextEn" | "welcomeTextDe" | "welcomeTextRu" | "welcomeTextJa";

const route = useRoute();
const router = useRouter();
const storedLanguage = localStorage.getItem("webspeak:language");
const language = ref<SiteLanguage>(storedLanguage === "en" || storedLanguage === "de" || storedLanguage === "ru" || storedLanguage === "ja" ? storedLanguage : typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ru") ? "ru" : typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ja") ? "ja" : "zh");
const { tr, formatDate, formatUptime, formatAge, sessionStateLabel, connectionStatusLabel, inviteStatusLabel, eventName, errorText, connectionFailureText } = useAdminI18n(language);
const themeMode = ref<ThemeMode>(getStoredTheme());
const themeIcon = computed(() => isDarkTheme(themeMode.value) ? "sun" : "moon");
const themeLabel = computed(() => isDarkTheme(themeMode.value) ? tr("switchToLightTheme") : tr("switchToDarkTheme"));
applyTheme(themeMode.value);
const loading = ref(true);
const screen = ref<Screen>("login");
const csrfToken = ref("");
const pageRequests = createAdminRequests();
const adminApi = createAdminApi({
  csrfToken: () => csrfToken.value,
  onUnauthorized: () => {
    cancelPendingWork();
    resetPrivateState();
    csrfToken.value = "";
    if (screen.value !== "login") { screen.value = "login"; void router.replace("/admin/login"); }
  },
});
const submitting = ref(false);
const loggingOut = ref(false);
const errorMessage = ref("");
const loginUsername = ref("admin");
const loginPassword = ref("");
const newPassword = ref("");
const confirmNewPassword = ref("");
const welcomeLanguage = ref<WelcomeLanguage>("zh");
const emptyOverview = () => ({ gateway: { version: "", uptimeSeconds: 0 }, teamSpeak: { target: "", status: "unknown", lastTestAt: null as string | null, latencyMs: null as number | null }, sessions: { active: 0, peak: 0, limit: 100 }, recentEvents: [] as Array<{ event: string; createdAt: string }>, legacyConfigImported: false });
const overview = reactive(emptyOverview());
const webrtcPortNoticeOpen = ref(false);
const serverSettings = useAdminServerSettings({ api: adminApi, errorMessage, errorText, refreshOverview: loadOverview });
const { serverForm, serverSaving, testing, testResult, loadServerSettings, saveServerSettings, testServerConnection, addRelayNode, removeRelayNode } = serverSettings;
const adminOperations = useAdminOperations({ api: adminApi, errorMessage, errorText, tr, refreshOverview: loadOverview });
const { operations, operationsLoading, terminatingSession, inviteSubmitting, revokingInvites, inviteForm, createdInvite,
  loadOperations, terminateSession, createInvite, revokeInvite, copyInviteLink, downloadBackup } = adminOperations;
const adminSkins = useAdminSkins({ api: adminApi, tr });
const { skinFileInput, skinEntries, skinLoading, skinUploading, removingSkinId, skinDefaultId, skinBusy,
  enabledSkinEntries, skinManagerError, skinManagerNotice, loadSkinCatalog, saveSkinDefault, toggleSkinEnabled, onSkinFileChanged, removeSkin } = adminSkins;

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

const passwordStrength = computed(() => Math.min(100, Math.max(8, newPassword.value.length * 5 + (/[\s\W]/.test(newPassword.value) ? 15 : 0))));
const currentPageTitle = computed(() => route.path === "/admin/server" ? tr('server') : route.path === "/admin/operations" ? tr('operations') : route.path === "/admin/skins" ? tr('skinLibrary') : tr('overview'));
const testResultTitle = computed(() => {
  const result = testResult.value;
  if (!result) return "";
  if (result.ok) return result.checkType === "network" ? tr("networkReachable") : tr("connectionReady");
  const names: Record<string, AdminTranslationKey> = {
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
onBeforeUnmount(() => { cancelPendingWork(); resetPrivateState(); });
watch(() => route.path, (path, previous) => {
  errorMessage.value = "";
  pageRequests.cancel("overview");
  if (previous === "/admin/server") serverSettings.cancelRequests();
  if (previous === "/admin/operations") adminOperations.cancelRequests();
  if (previous === "/admin/skins") adminSkins.cancelRequests();
  if (screen.value !== "admin" || loading.value || submitting.value || loggingOut.value) return;
  if (path === "/admin/operations") void loadOperations();
  else if (path === "/admin/skins") void loadSkinCatalog();
  else if (path === "/admin") void loadOverview();
});

function cancelPendingWork() {
  adminApi.invalidate();
  pageRequests.reset();
  serverSettings.cancelRequests();
  adminOperations.cancelRequests();
  adminSkins.cancelRequests();
  loading.value = false;
  submitting.value = false;
  loggingOut.value = false;
}
function resetPrivateState() {
  serverSettings.reset(); adminOperations.reset(); adminSkins.reset();
  Object.assign(overview, emptyOverview());
  loginPassword.value = ""; newPassword.value = ""; confirmNewPassword.value = "";
  errorMessage.value = "";
  webrtcPortNoticeOpen.value = false;
}
function report(error: unknown) {
  if (!isAdminRequestCancelled(error)) errorMessage.value = errorText((error as ApiError).code);
}
async function loadAdminData(request: { isCurrent(): boolean }) {
  await Promise.all([loadOverview(), loadServerSettings()]);
  if (!request.isCurrent()) return;
  if (route.path === "/admin/operations") await loadOperations();
  else if (route.path === "/admin/skins") await loadSkinCatalog();
}
async function loadAdminView() {
  const request = pageRequests.begin("auth");
  loading.value = true;
  try {
    const session = await adminApi.session(request.signal);
    if (!request.isCurrent()) return;
    if (!session.authenticated) {
      resetPrivateState(); csrfToken.value = ""; screen.value = "login";
      if (route.path !== "/admin/login") await router.replace("/admin/login");
    } else {
      csrfToken.value = session.csrfToken || "";
      screen.value = session.mustChangePassword ? "change-password" : "admin";
      if (session.mustChangePassword) await router.replace("/admin/change-password");
      else {
        if (route.path === "/admin/login" || route.path === "/admin/change-password") await router.replace("/admin");
        if (request.isCurrent()) await loadAdminData(request);
      }
    }
  } catch (error) { if (request.isCurrent()) report(error); }
  finally { if (request.isCurrent()) loading.value = false; request.finish(); }
}
async function login() {
  if (submitting.value) return;
  cancelPendingWork();
  const request = pageRequests.begin("auth");
  submitting.value = true; errorMessage.value = "";
  try {
    const result = await adminApi.login(loginUsername.value, loginPassword.value, request.signal);
    if (!request.isCurrent()) return;
    csrfToken.value = result.csrfToken;
    loginPassword.value = "";
    screen.value = result.mustChangePassword ? "change-password" : "admin";
    await router.replace(result.mustChangePassword ? "/admin/change-password" : "/admin");
    if (request.isCurrent() && !result.mustChangePassword) await loadAdminData(request);
  } catch (error) { if (request.isCurrent()) report(error); }
  finally { if (request.isCurrent()) submitting.value = false; request.finish(); }
}
async function changePassword() {
  if (submitting.value) return;
  errorMessage.value = "";
  if (newPassword.value.length < 12) { errorMessage.value = tr("setupPasswordShort"); return; }
  if (newPassword.value !== confirmNewPassword.value) { errorMessage.value = tr("setupPasswordsMismatch"); return; }
  const request = pageRequests.begin("auth");
  submitting.value = true;
  try {
    await adminApi.changePassword(newPassword.value, request.signal);
    if (!request.isCurrent()) return;
    newPassword.value = ""; confirmNewPassword.value = ""; screen.value = "admin";
    await router.replace("/admin");
    if (request.isCurrent()) await loadAdminData(request);
  } catch (error) { if (request.isCurrent()) report(error); }
  finally { if (request.isCurrent()) submitting.value = false; request.finish(); }
}
async function logout() {
  if (loggingOut.value) return;
  cancelPendingWork();
  const request = pageRequests.begin("auth");
  loggingOut.value = true; errorMessage.value = "";
  try {
    await adminApi.logout(request.signal);
    if (!request.isCurrent()) return;
    cancelPendingWork(); resetPrivateState(); csrfToken.value = ""; screen.value = "login";
    await router.replace("/admin/login");
  } catch (error) { if (request.isCurrent()) report(error); }
  finally { if (request.isCurrent()) loggingOut.value = false; request.finish(); }
}
async function loadOverview() {
  const request = pageRequests.begin("overview");
  try {
    const result = await adminApi.overview(request.signal);
    if (request.isCurrent()) Object.assign(overview, result);
  } catch (error) { if (request.isCurrent()) report(error); }
  finally { request.finish(); }
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
function handleWebRtcToggle() { if (serverForm.webRtcEnabled) webrtcPortNoticeOpen.value = true; }
async function dismissLegacyNotice() {
  const request = pageRequests.begin("legacy-notice");
  try {
    await adminApi.dismissLegacyNotice(request.signal);
    if (request.isCurrent()) overview.legacyConfigImported = false;
  } catch (error) { if (request.isCurrent()) report(error); }
  finally { request.finish(); }
}
function persistLanguage() { localStorage.setItem("webspeak:language", language.value); }
function cycleTheme() { themeMode.value = nextTheme(themeMode.value); saveTheme(themeMode.value); }
function connectionRoute(record: AdminConnectionRecord) {
  const route = tr("connectionFromTo", { ip: record.clientIp || "—", target: record.target || "—" });
  if (!record.relayName && !record.relayTarget) return route;
  const relay = [record.relayName, record.relayTarget].filter(Boolean).join(" · ") || "—";
  return `${route} · ${tr("connectionViaRelay", { relay })}`;
}
function formatContext(context: Record<string, string | number | boolean>) { return Object.entries(context).map(([key, value]) => `${key}=${value}`).join(" · "); }
</script>

<style scoped src="../styles/admin.css"></style>
