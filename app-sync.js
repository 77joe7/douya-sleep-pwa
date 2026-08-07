// ============================================================
// BabySleep 自建云端客户端（取代 supabase-sync.js）
// 架构：云端 (Supabase) 为主存储 | 本地 (localStorage) 仅缓存
// 规则：启动时云端优先覆盖本地 | 写入时即时上云 | 离线时本地缓存兜底
// 暴露 window.CloudSync，兼容 v2.3 调用点
// ============================================================
(function () {
  'use strict';

  const config = window.BABYSLEEP_CONFIG || {};
  const API = (config.supabaseUrl || '').replace(/\/$/, '');
  const KEY = config.supabaseAnonKey || '';
  const configured = API && KEY;

  // 本地存储
  const LS_TOKEN = 'babysleep_token';
  const LS_DEVICE = 'babysleep_device_id';
  const LS_DISPLAY = 'babysleep_display_name';
  const LS_IDENTITY = 'babysleep_identity_local';
  const LS_HINTED = 'babysleep_role_hinted';

  // 状态
  let app = null;
  let session = null;        // { token, household_id, family_name, baby_name, baby_id, device_id, display_name, identity_local }
  let babyId = null;         // 当前宝宝的 uuid
  let activityState = {};    // { sleep: 'started', feed: 'ended', ... }
  let pollTimer = null;
  let syncTimer = null;
  let syncing = false;

  // utils
  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
  function getDeviceId() {
    let id = localStorage.getItem(LS_DEVICE);
    if (!id) { id = uuid(); localStorage.setItem(LS_DEVICE, id); }
    return id;
  }
  function el(id) { return document.getElementById(id); }
  function notify(msg) { app?.notify?.(msg); }
  function setStatus(text, mode) {
    const s = el('cloudSyncStatus'); if (!s) return;
    s.textContent = text; s.className = 'cloud-status-pill' + (mode ? ' ' + mode : '');
  }
  function escapeText(v) { return String(v == null ? '' : v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

  /**
   * 把底层抛出的英文网络错误翻译成中文友好文案
   * fetch() 网络不可达/CORS/DNS 失败时抛 TypeError: Failed to fetch（Safari 为 Load failed）
   */
  function friendlyError(e) {
    const msg = (e && e.message) || String(e || '未知错误');
    if (msg.indexOf('Failed to fetch') !== -1 || msg.indexOf('NetworkError') !== -1 ||
        msg.indexOf('Network request failed') !== -1 || msg.indexOf('Load failed') !== -1) {
      return '网络连接失败，请检查网络后重试';
    }
    return msg;
  }

  // RPC 调用
  async function rpc(name, params, withSession) {
    const headers = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };
    if (withSession && session?.token) headers['X-App-Token'] = session.token;
    const res = await fetch(API + '/rest/v1/rpc/' + name, {
      method: 'POST', headers,
      body: JSON.stringify(params || {})
    });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) {
      const msg = (body && (body.message || body.error_description || body.msg)) || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return body;
  }

  // UI
  function refreshAccountUI() {
    const hint = el('cloudConfigHint');
    const signedOut = el('cloudSignedOut');
    const signedIn = el('cloudSignedIn');
    const accountSummary = el('cloudAccountSummary');
    if (!configured) {
      if (hint) hint.style.display = 'block';
      if (signedOut) signedOut.style.display = 'none';
      if (signedIn) signedIn.style.display = 'none';
      setStatus('本地模式');
      return;
    }
    if (hint) hint.style.display = 'none';
    if (!session) {
      if (signedOut) signedOut.style.display = 'block';
      if (signedIn) signedIn.style.display = 'none';
      setStatus('未登录');
      if (accountSummary) accountSummary.textContent = '登录后可与家人共享记录。';
      return;
    }
    if (signedOut) signedOut.style.display = 'none';
    if (signedIn) signedIn.style.display = 'block';
    const localDisplay = localStorage.getItem(LS_DISPLAY) || session.display_name || '家庭成员';
    const localIdentity = localStorage.getItem(LS_IDENTITY) || session.identity_local || 'editor';
    if (el('cloudUserEmail')) el('cloudUserEmail').textContent = '已登录：' + (session.baby_id || '家庭成员');
    if (el('cloudDisplayName')) el('cloudDisplayName').value = localDisplay;
    if (el('cloudIdentity')) el('cloudIdentity').value = localIdentity;
    if (el('cloudFamilyInfo')) {
      el('cloudFamilyInfo').style.display = 'block';
      el('cloudFamilyInfo').innerHTML =
        '<b>家庭：</b>' + escapeText(session.family_name || '宝宝之家') +
        '<br><b>宝宝ID：</b>' + escapeText(session.baby_id || '') +
        '<br><b>本机身份：</b>' + escapeText(localIdentity === 'viewer' ? '查看者' : '编辑者') +
        '<br><b>本机显示：</b>' + escapeText(localDisplay) +
        '<br><b>数据保护：</b>每日自动备份已开启（应用更新不丢数据）';
    }
    if (accountSummary) accountSummary.textContent = (session.family_name || '宝宝之家') + ' · ' + (localIdentity === 'viewer' ? '查看者' : '编辑者') + ' · ' + localDisplay;
    setStatus(navigator.onLine ? '已同步' : '离线缓存', navigator.onLine ? 'online' : '');
  }

  // 状态机：toggle 活动（旧 v2.4 兼容，保留）
  async function appendActivity(type, op, ts) {
    if (!session || !babyId) return { accepted: false, ignored: true, state: activityState[type] || 'ended' };
    try {
      const r = await rpc('append_activity', { p_baby_id: babyId, p_type: type, p_op: op, p_ts: ts, p_device_id: getDeviceId() }, true);
      const row = Array.isArray(r) ? r[0] : r;
      const accepted = row && row.accepted === true;
      const ignored = row && row.ignored === true;
      const state = row && row.state || (op === 'start' ? 'started' : 'ended');
      activityState[type] = state;
      if (!accepted) {
        console.info('[toggle] ignored', type, op, 'current=', state);
      }
      return { accepted, ignored, state, event_id: row?.event_id };
    } catch (e) {
      console.warn('[append_activity] failed', e);
      return { accepted: false, ignored: true, state: activityState[type] || 'ended', error: e.message };
    }
  }

  // v2.5 事件流 RPC：睡眠去 toggle + 冲突检测
  async function appendActivityV2(type, op, ts) {
    if (!session || !babyId) return { accepted: false, ignored: true, state: 'ended' };
    try {
      const name = localStorage.getItem(LS_DISPLAY) || session.display_name || '家人';
      const role = localStorage.getItem(LS_IDENTITY) || 'editor';
      const r = await rpc('append_activity_v2', {
        p_baby_id: babyId, p_type: type, p_op: op, p_ts: ts,
        p_device_id: getDeviceId(), p_recorder_name: name, p_recorder_role: role,
        p_metadata: {}
      }, true);
      const row = Array.isArray(r) ? r[0] : r;
      const accepted = row && row.accepted === true;
      const ignored = row && row.ignored === true;
      const state = row && row.state || 'ended';
      const conflict = row && row.conflict === true;
      const conflictMsg = row && row.conflict_msg || '';
      if (accepted || (!conflict)) activityState[type] = state;
      return { accepted, ignored, state, conflict, conflict_msg: conflictMsg, event_id: row?.event_id };
    } catch (e) {
      console.warn('[append_activity_v2] failed', e);
      return { accepted: false, ignored: true, state: activityState[type] || 'ended', error: e.message };
    }
  }

  async function refreshActivityState() {
    if (!session || !babyId) return;
    try {
      // v2.5 优先使用计算状态
      const r = await rpc('list_activity_state_v2', { p_baby_id: babyId }, true);
      const map = {};
      (r || []).forEach(row => { map[row.type] = row.state || 'ended'; });
      activityState = map;
      app?.applyState?.(activityState);
    } catch (e) {
      // 回退到旧 RPC
      try {
        const r = await rpc('list_activity_state', { p_baby_id: babyId }, true);
        const map = {};
        (r || []).forEach(row => { map[row.type] = row.state || 'ended'; });
        activityState = map;
        app?.applyState?.(activityState);
      } catch (e2) { console.warn('[list_activity_state] failed', e2); }
    }
  }

  // Supabase Realtime 订阅（替代轮询）
  let realtimeChannel = null;
  function startRealtime() {
    if (!configured || !babyId) return;
    stopRealtime();
    const channel = API + '/rest/v1/events?baby_id=eq.' + babyId + '&select=*';
    // 使用 SSE 方式替代 WebSocket（更简单，兼容性好）
    // 持续轮询 + visibility 暂停已在前端处理
  }
  function stopRealtime() { /* reserved for future WebSocket */ }

  // 事件（详情）
  async function loadEventsFromCloud(dateFrom, dateTo) {
    if (!session || !babyId) return null;
    try {
      const r = await rpc('list_events', { p_baby_id: babyId, p_date_from: dateFrom, p_date_to: dateTo }, true);
      return (r || []).map(rowToEvent);
    } catch (e) { console.warn('[list_events] failed', e); return null; }
  }

  async function pushEventToCloud(ev) {
    if (!session || !babyId) return false;
    try {
      await rpc('upsert_event', {
        p_id: ev.id, p_baby_id: babyId, p_type: ev.type, p_ts: ev.ts,
        p_status: ev.status || 'complete', p_activity_key: ev.activityKey || null,
        p_session_id: ev.sessionId || null, p_payload: ev.payload || {},
        p_recorder_name: ev.recorderName || localStorage.getItem(LS_DISPLAY) || '家庭成员',
        p_recorder_role: ev.recorderRole || (localStorage.getItem(LS_IDENTITY) || 'editor')
      }, true);
      return true;
    } catch (e) { console.warn('[upsert_event] failed', e); return false; }
  }

  async function deleteEventRemote(id) {
    if (!session) return;
    try { await rpc('delete_event', { p_id: id }, true); }
    catch (e) { console.warn('[delete_event] failed', e); }
  }
  async function clearEventsRemote() {
    if (!session || !babyId) return;
    try { await rpc('clear_events', { p_baby_id: babyId }, true); }
    catch (e) { console.warn('[clear_events] failed', e); }
  }

  async function saveIdentity(displayName, identityLocal) {
    if (!session) return notify('请先登录');
    const cleanName = (displayName || '').trim();
    const cleanIdentity = (identityLocal || '').trim() || 'editor';
    if (cleanName) localStorage.setItem(LS_DISPLAY, cleanName);
    localStorage.setItem(LS_IDENTITY, cleanIdentity);
    try {
      await rpc('auth_set_device', { p_display_name: cleanName, p_identity: cleanIdentity }, true);
      session.display_name = cleanName || session.display_name;
      session.identity_local = cleanIdentity;
      refreshAccountUI();
      notify('身份已保存');
    } catch (e) { notify('保存失败：' + friendlyError(e)); }
  }

  async function renameFamily(familyName) {
    if (!session) return notify('请先登录');
    const clean = (familyName || '').trim();
    if (!clean) return notify('家庭名称不能为空');
    try {
      await rpc('auth_rename_household', { p_family_name: clean }, true);
      session.family_name = clean;
      refreshAccountUI();
      notify('家庭名称已更新');
    } catch (e) { notify('修改失败：' + friendlyError(e)); }
  }

  async function changePassword(oldPw, newPw) {
    if (!session) return notify('请先登录');
    try {
      await rpc('auth_change_password', { p_old_password: oldPw, p_new_password: newPw }, true);
      notify('密码已修改');
    } catch (e) { notify('修改失败：' + friendlyError(e)); }
  }

  function rowToEvent(row) {
    return {
      id: row.id, type: row.type, ts: Number(row.ts),
      status: row.status, activityKey: row.activity_key, sessionId: row.session_id,
      payload: row.payload || {},
      recorderName: row.recorder_name, recorderRole: row.recorder_role,
      deviceId: row.device_id
    };
  }

  // 同步
  async function syncNow() {
    if (!session || !babyId || !navigator.onLine || syncing) return;
    syncing = true;
    setStatus('同步中', 'syncing');
    try {
      const list = app?.getEvents?.() || [];
      for (const ev of list) {
        await pushEventToCloud(ev);
      }
      await refreshActivityState();
      // 拉取云端事件替换本地（云端为准）
      const now = Date.now();
      const remote = await loadEventsFromCloud(now - 365 * 86400 * 1000, now + 86400 * 1000);
      if (remote && app?.replaceEvents) {
        app.replaceEvents(remote);
      }
      setStatus('已同步', 'online');
    } catch (e) {
      console.warn('[sync] failed', e);
      setStatus('离线缓存');
    } finally { syncing = false; }
  }

  function queueSync() {
    if (!session) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(), 400);
  }

  // 轮询（替代 realtime，3 秒一次；页面不可见时暂停）
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(runPoll, 3000);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  async function runPoll() {
    if (!session || !babyId || syncing) return;
    await refreshActivityState();
    const list = app?.getEvents?.() || [];
    if (list.length) for (const ev of list) await pushEventToCloud(ev);
    const now = Date.now();
    const remote = await loadEventsFromCloud(now - 30 * 86400 * 1000, now + 86400 * 1000);
    if (remote && app?.replaceEvents) app.replaceEvents(remote);
  }

  // 页面不可见时暂停轮询；恢复时立即同步
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling();
    } else if (session) {
      startPolling();
      syncNow();
    }
  });

  // 认证
  async function login(babyIdInput, password) {
    if (!configured) return notify('Supabase 配置未填写');
    if (!babyIdInput || !password) return notify('请填写宝宝ID和密码');
    try {
      const r = await rpc('auth_login', { p_baby_id: babyIdInput, p_password: password, p_device_id: getDeviceId() });
      const row = Array.isArray(r) ? r[0] : r;
      session = { token: row.token, household_id: row.household_id, family_name: row.family_name, baby_name: row.baby_name, baby_id: row.baby_id, display_name: row.display_name || '家庭成员', identity_local: 'editor' };
      localStorage.setItem(LS_TOKEN, session.token);
      // 通过 auth_get_session 获取宝宝 uuid（不走直接 REST，避免 revoke 权限阻断）
      await resolveBabyId();
      refreshAccountUI();
      notify('登录成功');
      startPolling();
      app?.afterLogin?.();
      checkFirstTimeIdentity();
    } catch (e) {
      notify('登录失败：' + friendlyError(e));
    }
  }

  async function createHousehold(babyIdInput, password, familyName, babyName) {
    if (!configured) return notify('Supabase 配置未填写');
    if (!babyIdInput || !password || !familyName || !babyName) return notify('请填写完整信息');
    try {
      const r = await rpc('auth_create_household', { p_baby_id: babyIdInput, p_password: password, p_family_name: familyName, p_baby_name: babyName, p_device_id: getDeviceId() });
      const row = Array.isArray(r) ? r[0] : r;
      session = { token: row.token, household_id: row.household_id, family_name: row.family_name, baby_name: row.baby_name, baby_id: row.baby_id, display_name: '家庭成员', identity_local: 'editor' };
      localStorage.setItem(LS_TOKEN, session.token);
      await resolveBabyId();
      refreshAccountUI();
      notify('家庭已创建');
      startPolling();
      app?.afterLogin?.();
      checkFirstTimeIdentity();
    } catch (e) {
      notify('创建失败：' + friendlyError(e));
    }
  }

  // 通过 auth_get_session RPC 取 baby_uuid（回避直接 REST 查表的 revoke 问题）
  async function resolveBabyId() {
    if (!session) return;
    try {
      const r = await rpc('auth_get_session', {}, true);
      const row = Array.isArray(r) ? r[0] : r;
      if (row && row.baby_uuid) babyId = row.baby_uuid;
    } catch (e) { console.warn('[resolveBabyId] failed', e); }
  }

  async function restoreSession() {
    if (!configured) return false;
    const token = localStorage.getItem(LS_TOKEN);
    if (!token) return false;
    // 临时挂上 token 试 get_session
    const old = session;
    session = { token };
    try {
      const r = await rpc('auth_get_session', {});
      const row = Array.isArray(r) ? r[0] : r;
      session = { token, household_id: row.household_id, family_name: row.family_name, baby_name: row.baby_name, baby_id: row.baby_id, device_id: row.device_id, display_name: row.display_name || '家庭成员', identity_local: row.identity_local || 'editor' };
      localStorage.setItem(LS_TOKEN, session.token);
      // 同步本机的 display_name / identity_local
      if (!localStorage.getItem(LS_DISPLAY)) localStorage.setItem(LS_DISPLAY, session.display_name);
      if (!localStorage.getItem(LS_IDENTITY)) localStorage.setItem(LS_IDENTITY, session.identity_local);
      await resolveBabyId();
      refreshAccountUI();
      // 云端为主：启动时立即拉取云端事件替换本地缓存
      const now = Date.now();
      const remote = await loadEventsFromCloud(now - 365 * 86400 * 1000, now + 86400 * 1000);
      if (remote && app?.replaceEvents) app.replaceEvents(remote);
      startPolling();
      app?.afterLogin?.();
      return true;
    } catch (e) {
      session = old;
      localStorage.removeItem(LS_TOKEN);
      return false;
    }
  }

  async function signOut() {
    try { await rpc('auth_logout', {}, true); } catch (e) {}
    session = null; babyId = null; activityState = {};
    localStorage.removeItem(LS_TOKEN);
    stopPolling();
    refreshAccountUI();
    notify('已退出登录');
  }

  // 首次身份选择
  function checkFirstTimeIdentity() {
    const hinted = localStorage.getItem(LS_HINTED);
    if (hinted) return;
    app?.showIdentityPicker?.();
  }

  window.addEventListener('online', () => { if (session) { syncNow(); } });
  window.addEventListener('offline', () => { if (session) setStatus('离线缓存'); });

  function init(appBridge) {
    app = appBridge;
    refreshAccountUI();
    if (!configured) return;
    restoreSession().then(ok => {
      if (!ok) refreshAccountUI();
    });
  }

  // 曝光给 v2.3 调用点的兼容接口
  window.CloudSync = {
    init,
    queueSync,
    syncNow,
    refreshAccountUI,
    // 兼容旧调用：
    sendLoginLink: () => notify('已改为密码登录，请使用下方密码登录'),
    passwordAuth: (email, password) => { /* 兼容老代码 */ login(email, password); },
    saveIdentity: (name, identity) => saveIdentity(name, identity === '查看者' ? 'viewer' : (identity || 'editor')),
    createFamily: (familyName, babyName) => {
      const babyIdInput = (el('cloudBabyId') && el('cloudBabyId').value) || (el('cloudEmail') && el('cloudEmail').value) || '';
      const password = el('cloudPassword') && el('cloudPassword').value;
      createHousehold(babyIdInput, password, familyName, babyName);
    },
    joinFamily: () => notify('共享账号模式：直接用宝宝ID+密码登录即可'),
    signOut,
    deleteEvent: deleteEventRemote,
    clearEvents: clearEventsRemote,
    // 新增
    login,
    createHousehold,
    appendActivity,
    appendActivityV2,
    refreshActivityState,
    loadEventsFromCloud,
    pushEventToCloud,
    saveIdentityLocal: saveIdentity,
    getRecorder: () => ({
      id: getDeviceId(),
      name: localStorage.getItem(LS_DISPLAY) || session?.display_name || '家庭成员',
      role: localStorage.getItem(LS_IDENTITY) || session?.identity_local || 'editor'
    }),
    getIdentityLocal: () => localStorage.getItem(LS_IDENTITY) || 'editor',
    getLocalDisplayName: () => localStorage.getItem(LS_DISPLAY) || session?.display_name || '家庭成员',
    getDeviceId: () => getDeviceId(),
    renameFamily,
    changePassword,
    isSignedIn: () => !!session,
    getBabyId: () => babyId,
    getSession: () => session,
    isConfigured: () => configured
  };
})();
