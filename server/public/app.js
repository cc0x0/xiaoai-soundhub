let authToken = localStorage.getItem('soundhub_token') || '';
if (!authToken) {
  window.location.href = '/login';
}

const STORAGE_KEYS = {
  selectedDids: 'soundhub_selected_dids',
  searchSource: 'soundhub_search_source',
};

let currentUser = JSON.parse(localStorage.getItem('soundhub_user') || '{}');
let devices = [];
let selectedDids = new Set(loadSelectedDids());
let isPlaying = false;
/** Null until /api/sources answers; the server decides the initial value. */
let activeSearchSource = localStorage.getItem(STORAGE_KEYS.searchSource) || null;
let availableSources = [];
/** True once the user has an explicit device selection worth restoring. */
let hasStoredSelection = selectedDids.size > 0;

// ===== 本地偏好持久化 =====
function loadSelectedDids() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.selectedDids);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((d) => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

function persistSelectedDids() {
  try {
    localStorage.setItem(STORAGE_KEYS.selectedDids, JSON.stringify(Array.from(selectedDids)));
  } catch {
    // localStorage may be unavailable (private mode); selection stays in-memory
  }
}

// ===== Loading 状态基建 =====

/**
 * Put a button into a busy state for the duration of an async action, so every
 * click gives immediate feedback and cannot be fired twice.
 */
async function withButtonLoading(button, label, task) {
  const el = typeof button === 'string' ? document.getElementById(button) : button;
  if (!el) return await task();

  const originalHtml = el.innerHTML;
  const wasDisabled = el.disabled;
  el.disabled = true;
  el.classList.add('is-loading');
  el.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span><span>${label || '处理中...'}</span>`;

  try {
    return await task();
  } finally {
    el.disabled = wasDisabled;
    el.classList.remove('is-loading');
    el.innerHTML = originalHtml;
  }
}

/** Render a skeleton placeholder list while a panel is loading. */
function renderSkeleton(container, rows = 3) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;
  el.innerHTML = Array.from({ length: rows })
    .map(() => '<div class="skeleton-row"><div class="skeleton-line long"></div><div class="skeleton-line short"></div></div>')
    .join('');
}

function setGlobalBusy(isBusy) {
  document.body.classList.toggle('app-busy', !!isBusy);
}

// 现代 Toast 浮动通知组件
function showToast(message, type = 'info', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const icons = {
    success: '🎉',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️'
  };

  const toast = document.createElement('div');
  toast.className = `toast-item toast-${type}`;
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span style="flex:1;">${message}</span>`;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  setTimeout(() => {
    toast.classList.remove('show');
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}
window.showToast = showToast;

// 统一封装带鉴权的请求
async function authFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem('soundhub_token');
    window.location.href = '/login';
  }
  return res;
}

// 1. 初始化
document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  await initUserProfile();
  await Promise.all([fetchSources(), fetchDevices()]);
  fetchStatus();

  // 定时拉取播放状态
  setInterval(fetchStatus, 4000);
});

// ===== 音源渠道选择器 =====

/** Load the available source channels and render the picker. */
async function fetchSources() {
  const tabs = document.getElementById('source-tabs');
  try {
    const res = await authFetch('/api/sources');
    const json = await res.json();
    if (!json.ok || !json.data) throw new Error('音源列表加载失败');

    const { aggregate, platforms, current } = json.data;
    availableSources = [aggregate, ...platforms];

    // A stored choice wins, so a reload keeps the channel the user picked.
    const known = availableSources.some((s) => s.id === activeSearchSource);
    if (!known) activeSearchSource = current || aggregate.id;

    renderSourceTabs();
  } catch (err) {
    if (tabs) {
      tabs.innerHTML = `<span class="source-tab-error">音源列表加载失败: ${escapeHtml(err.message)}</span>`;
    }
  }
}

const SOURCE_ICONS = { all: '🔀', kw: '🎵', tx: '🐧', kg: '🎤', mg: '📻', wy: '☁️' };

function renderSourceTabs() {
  const tabs = document.getElementById('source-tabs');
  if (!tabs) return;

  tabs.innerHTML = availableSources
    .map((source) => {
      const isActive = source.id === activeSearchSource;
      return `
        <button type="button"
                class="source-tab ${isActive ? 'active' : ''}"
                data-source="${escapeHtml(source.id)}"
                aria-pressed="${isActive}">
          <span class="source-tab-icon">${SOURCE_ICONS[source.id] || '🎼'}</span>
          <span>${escapeHtml(source.name)}</span>
        </button>
      `;
    })
    .join('');

  tabs.querySelectorAll('.source-tab').forEach((btn) => {
    btn.addEventListener('click', () => selectSearchSource(btn.getAttribute('data-source')));
  });
}

/** Switch channel, remember it, and re-run the current query. */
function selectSearchSource(sourceId) {
  if (!sourceId || sourceId === activeSearchSource) return;
  activeSearchSource = sourceId;
  try {
    localStorage.setItem(STORAGE_KEYS.searchSource, sourceId);
  } catch {
    // ignore storage failures
  }
  renderSourceTabs();

  const name = availableSources.find((s) => s.id === sourceId)?.name || sourceId;
  showToast(`已切换搜索音源: ${name}`, 'info', 2000);

  if (document.getElementById('search-input')?.value.trim()) {
    doSearch();
  }
}

async function initUserProfile() {
  try {
    const res = await authFetch('/api/auth/me');
    const json = await res.json();
    if (json.ok) {
      currentUser = json.data;
      localStorage.setItem('soundhub_user', JSON.stringify(currentUser));
      const nameEl = document.getElementById('user-display-name');
      if (nameEl) nameEl.innerText = currentUser.username;
      
      const badge = document.getElementById('user-plan-badge');
      if (badge) {
        badge.innerText = currentUser.plan.toUpperCase();
        badge.className = 'plan-badge plan-' + currentUser.plan;
      }

      if (currentUser.role === 'admin') {
        const adminBtn = document.getElementById('btn-go-admin');
        if (adminBtn) adminBtn.style.display = 'inline-block';
      }
    }
  } catch (e) {
    console.error('Fetch user profile failed:', e);
  }
}

function bindEvents() {
  document.getElementById('btn-refresh-devices')?.addEventListener('click', () =>
    withButtonLoading('btn-refresh-devices', '同步中', fetchDevices)
  );
  document.getElementById('btn-select-all')?.addEventListener('click', selectAllDevices);
  document.getElementById('btn-deselect-all')?.addEventListener('click', deselectAllDevices);
  document.getElementById('btn-send-tts')?.addEventListener('click', sendTTS);
  document.getElementById('btn-search')?.addEventListener('click', doSearch);
  document.getElementById('search-input')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  // 米家账号绑定弹窗
  document.getElementById('btn-open-bind-modal')?.addEventListener('click', () => {
    const m = document.getElementById('bind-mi-modal');
    if (m) m.style.display = 'flex';
  });
  document.getElementById('btn-submit-quick-bind')?.addEventListener('click', submitQuickBindMi);
  document.getElementById('btn-submit-bind')?.addEventListener('click', submitBindMi);
  document.getElementById('btn-unbind-mi')?.addEventListener('click', handleUnbindMi);

  // VIP 兑换弹窗
  document.getElementById('btn-open-redeem-modal')?.addEventListener('click', () => {
    const m = document.getElementById('redeem-modal');
    if (m) m.style.display = 'flex';
  });
  document.getElementById('btn-submit-redeem')?.addEventListener('click', submitRedeem);

  // 个人偏好设置弹窗
  document.getElementById('btn-open-settings-modal')?.addEventListener('click', () => {
    loadUserSettings();
    const m = document.getElementById('user-settings-modal');
    if (m) m.style.display = 'flex';
  });
  document.getElementById('btn-save-user-settings')?.addEventListener('click', saveUserSettings);

  // 快捷常用语
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('tts-input').value = chip.getAttribute('data-text');
    });
  });

  // 快捷热门歌手
  document.querySelectorAll('.hot-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('search-input').value = chip.textContent;
      doSearch();
    });
  });

  // 播放控制器
  document.getElementById('btn-toggle-play')?.addEventListener('click', () => controlPlay(isPlaying ? 'pause' : 'resume'));
  document.getElementById('btn-next')?.addEventListener('click', () => controlPlay('next'));
  document.getElementById('btn-prev')?.addEventListener('click', () => controlPlay('prev'));
  document.getElementById('btn-stop')?.addEventListener('click', () => controlPlay('stop'));
}

window.switchBindMode = function(mode) {
  const isAdv = mode === 'advanced';
  const btnAdv = document.getElementById('tab-bind-advanced');
  const btnQuick = document.getElementById('tab-bind-quick');
  
  if (btnAdv && btnQuick) {
    btnAdv.style.background = isAdv ? '#3b82f6' : 'transparent';
    btnAdv.style.color = isAdv ? '#fff' : 'var(--text-muted)';
    btnQuick.style.background = !isAdv ? '#3b82f6' : 'transparent';
    btnQuick.style.color = !isAdv ? '#fff' : 'var(--text-muted)';
  }

  document.getElementById('panel-bind-advanced').style.display = isAdv ? 'block' : 'none';
  document.getElementById('panel-bind-quick').style.display = !isAdv ? 'block' : 'none';
};

window.closeBindModal = function() {
  const m = document.getElementById('bind-mi-modal');
  if (m) m.style.display = 'none';
};

window.closeRedeemModal = function() {
  const m = document.getElementById('redeem-modal');
  if (m) m.style.display = 'none';
};

window.closeUserSettingsModal = function() {
  const m = document.getElementById('user-settings-modal');
  if (m) m.style.display = 'none';
};

async function loadUserSettings() {
  try {
    const res = await authFetch('/api/user/settings');
    const json = await res.json();
    if (json.ok && json.data) {
      const s = json.data;
      let prefixes = [];
      let stopWords = [];
      try { prefixes = JSON.parse(s.custom_prefixes || '[]'); } catch {}
      try { stopWords = JSON.parse(s.custom_stop_keywords || '[]'); } catch {}

      const prefInput = document.getElementById('user-pref-prefixes');
      if (prefInput) prefInput.value = prefixes.join(', ');

      const stopInput = document.getElementById('user-pref-stop-words');
      if (stopInput) stopInput.value = stopWords.join(', ');

      const qualitySelect = document.getElementById('user-pref-quality');
      if (qualitySelect && s.preferred_quality) qualitySelect.value = s.preferred_quality;

      const chimeSelect = document.getElementById('user-pref-chime');
      if (chimeSelect && s.default_chime) chimeSelect.value = s.default_chime;

      const platformSelect = document.getElementById('user-pref-search-platform');
      if (platformSelect) platformSelect.value = s.search_platform || 'all';
    }
  } catch (e) {
    console.error('Load user settings failed:', e);
  }
}

async function saveUserSettings() {
  const prefRaw = document.getElementById('user-pref-prefixes').value.trim();
  const stopRaw = document.getElementById('user-pref-stop-words').value.trim();
  const preferred_quality = document.getElementById('user-pref-quality').value;
  const default_chime = document.getElementById('user-pref-chime').value;
  const search_platform = document.getElementById('user-pref-search-platform')?.value || 'all';

  const custom_prefixes = prefRaw ? prefRaw.split(/[,，\s]+/).filter(Boolean) : [];
  const custom_stop_keywords = stopRaw ? stopRaw.split(/[,，\s]+/).filter(Boolean) : [];

  await withButtonLoading('btn-save-user-settings', '正在保存', async () => {
    try {
      const res = await authFetch('/api/user/settings', {
        method: 'POST',
        body: JSON.stringify({
          custom_prefixes,
          custom_stop_keywords,
          preferred_quality,
          default_chime,
          search_platform,
          enable_tts_chime: default_chime !== 'none' ? 1 : 0
        })
      });
      const json = await res.json();
      if (json.ok) {
        showToast('🎉 个人偏好设置已保存，语音点歌将使用新音源', 'success');
        window.closeUserSettingsModal();

        // Keep the web picker aligned with the newly saved voice-search source.
        if (search_platform !== activeSearchSource) {
          activeSearchSource = search_platform;
          try {
            localStorage.setItem(STORAGE_KEYS.searchSource, search_platform);
          } catch {
            // ignore storage failures
          }
          renderSourceTabs();
        }
      } else {
        showToast(json.error || '保存失败', 'error');
      }
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}

async function submitQuickBindMi() {
  const account = document.getElementById('bind-quick-account').value.trim();
  const password = document.getElementById('bind-quick-password').value;
  const nickname = document.getElementById('bind-quick-nickname').value.trim();

  if (!account || !password) {
    showToast('请填写小米账号（手机号/邮箱）和密码', 'warning');
    return;
  }

  await withButtonLoading('btn-submit-quick-bind', '正在直连小米登录', async () => {
    try {
      const res = await authFetch('/api/user/account/login-bind', {
        method: 'POST',
        body: JSON.stringify({ account, password, nickname })
      });
      const json = await res.json();
      if (json.ok) {
        showToast(json.msg, 'success');
        window.closeBindModal();
        fetchDevices();
      } else {
        showToast(json.error || '登录绑定失败', 'error');
      }
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}

async function submitBindMi() {
  const xiaomiUserId = document.getElementById('bind-mi-userid').value.trim();
  const passToken = document.getElementById('bind-mi-token').value.trim();
  const nickname = document.getElementById('bind-mi-nickname').value.trim();

  if (!xiaomiUserId || !passToken) {
    showToast('请填写小米账号ID与passToken', 'warning');
    return;
  }

  await withButtonLoading('btn-submit-bind', '正在保存并同步', async () => {
    try {
      const res = await authFetch('/api/user/account', {
        method: 'POST',
        body: JSON.stringify({ xiaomiUserId, passToken, nickname })
      });
      const json = await res.json();
      if (json.ok) {
        showToast('🎉 ' + json.msg, 'success');
        window.closeBindModal();
        fetchDevices();
      } else {
        showToast(json.error || '绑定失败', 'error');
      }
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}

async function handleUnbindMi() {
  if (!confirm('确定要解绑当前小米账号并彻底销毁凭证吗？')) return;

  setGlobalBusy(true);
  try {
    const res = await authFetch('/api/user/account', {
      method: 'DELETE'
    });
    const json = await res.json();
    if (json.ok) {
      showToast(json.msg, 'success');
      window.closeBindModal();
      fetchDevices();
    }
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setGlobalBusy(false);
  }
}

async function submitRedeem() {
  const code = document.getElementById('redeem-code-input').value.trim();
  if (!code) {
    showToast('请输入兑换码', 'warning');
    return;
  }

  await withButtonLoading('btn-submit-redeem', '正在校验兑换码', async () => {
    try {
      const res = await authFetch('/api/user/redeem', {
        method: 'POST',
        body: JSON.stringify({ code })
      });
      const json = await res.json();
      if (json.ok) {
        showToast(json.msg, 'success');
        window.closeRedeemModal();
        initUserProfile();
      } else {
        showToast(json.error || '兑换失败', 'error');
      }
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}

window.handleUnbindMi = handleUnbindMi;
window.submitQuickBindMi = submitQuickBindMi;
window.submitBindMi = submitBindMi;
window.submitRedeem = submitRedeem;
window.saveUserSettings = saveUserSettings;
window.copySnippet = function(el) {
  const text = el.innerText || el.textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('提取代码已复制到剪贴板！', 'success');
    }).catch(() => {
      showToast('请直接双击全选复制代码', 'info');
    });
  } else {
    showToast('请直接双击全选复制代码', 'info');
  }
};

let activeQueues = {};

// 2. 状态查询 (毫秒级感知全屋各音箱播放状态)
async function fetchStatus() {
  try {
    const res = await authFetch('/api/status');
    const json = await res.json();
    if (json.ok) {
      const statusEl = document.getElementById('status-text');
      if (statusEl) statusEl.textContent = '服务在线';
      
      const badgeEl = document.getElementById('active-source-badge');
      if (badgeEl) badgeEl.textContent = `音源: ${json.data.activeSource || '在线'}`;
      
      activeQueues = json.data.activeQueues || {};
      const activeDidList = Object.keys(activeQueues);

      // 实时更新左侧音箱卡片中的放歌状态与波形
      renderDevices();

      // 更新底部播放控制区域
      const multiContainer = document.getElementById('multi-player-list');
      const singlePlayerBar = document.getElementById('player-bar');

      if (activeDidList.length === 0) {
        const titleEl = document.getElementById('player-title');
        const artistEl = document.getElementById('player-artist');
        if (titleEl) titleEl.innerHTML = '暂无播放歌曲';
        if (artistEl) artistEl.textContent = '小爱音箱待命';
        isPlaying = false;
        const btnPlay = document.getElementById('btn-toggle-play');
        if (btnPlay) btnPlay.textContent = '▶️';
        if (multiContainer) multiContainer.style.display = 'none';
        if (singlePlayerBar) singlePlayerBar.style.display = 'flex';
      } else if (activeDidList.length === 1) {
        const did = activeDidList[0];
        const state = activeQueues[did];
        const dev = devices.find((d) => d.did === did);
        const devName = dev?.name || dev?.alias || did;

        const titleEl = document.getElementById('player-title');
        const artistEl = document.getElementById('player-artist');
        if (titleEl) {
          titleEl.innerHTML = `
            <span class="speaker-badge">🔊 ${escapeHtml(devName)}</span>
            <span class="song-title-text">${escapeHtml(state.music.name)}</span>
          `;
        }
        if (artistEl) artistEl.textContent = state.music.singer || '';
        isPlaying = true;
        const btnPlay = document.getElementById('btn-toggle-play');
        if (btnPlay) btnPlay.textContent = '⏸️';
        if (multiContainer) multiContainer.style.display = 'none';
        if (singlePlayerBar) singlePlayerBar.style.display = 'flex';
      } else {
        // 多台设备同时放歌 (支持不同歌曲独立展示与独立控制)
        if (multiContainer) {
          multiContainer.style.display = 'flex';
          multiContainer.innerHTML = activeDidList
            .map((did) => {
              const state = activeQueues[did];
              const dev = devices.find((d) => d.did === did);
              const devName = dev?.name || dev?.alias || did;
              return `
              <div class="multi-player-card">
                <div class="multi-card-info">
                  <div class="multi-card-speaker">🔊 ${escapeHtml(devName)}</div>
                  <div class="multi-card-song"><strong>${escapeHtml(state.music.name)}</strong> - ${escapeHtml(state.music.singer)}</div>
                </div>
                <div class="multi-card-controls">
                  <button class="multi-ctrl-btn" onclick="controlSingleSpeaker('${did}', 'pause')" title="暂停">⏸️</button>
                  <button class="multi-ctrl-btn" onclick="controlSingleSpeaker('${did}', 'resume')" title="继续">▶️</button>
                  <button class="multi-ctrl-btn" onclick="controlSingleSpeaker('${did}', 'next')" title="下一首">⏭️</button>
                  <button class="multi-ctrl-btn" onclick="controlSingleSpeaker('${did}', 'stop')" title="停止">⏹️</button>
                </div>
              </div>
            `;
            })
            .join('');
        }
        if (singlePlayerBar) singlePlayerBar.style.display = 'none';
      }
    }
  } catch {
    const statusEl = document.getElementById('status-text');
    if (statusEl) statusEl.textContent = '连接中断';
  }
}

window.handleUserLogout = function() {
  localStorage.removeItem('soundhub_token');
  localStorage.removeItem('soundhub_user');
  window.location.href = '/login';
};

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 3. 拉取设备列表
async function fetchDevices() {
  const container = document.getElementById('device-list');
  renderSkeleton(container, 3);

  try {
    const res = await authFetch('/api/user/speakers');
    const json = await res.json();

    if (json.ok && json.data) {
      devices = json.data;
      document.getElementById('device-count').textContent = devices.length;

      if (devices.length === 0) {
        container.innerHTML =
          '<div class="empty-hint"><div class="empty-hint-icon">📻</div><div>暂未发现音箱</div><div class="empty-hint-sub">点击右上角「绑定米家」同步设备</div></div>';
        return;
      }

      const knownDids = new Set(devices.map((d) => d.did));
      // Drop stored dids whose speaker is gone, so stale ids never linger.
      for (const did of Array.from(selectedDids)) {
        if (!knownDids.has(did)) selectedDids.delete(did);
      }

      // First visit only: preselect every non-ignored speaker. Afterwards the
      // user's own selection is authoritative — including an empty one.
      if (!hasStoredSelection) {
        devices.forEach((d) => {
          if (!d.is_ignored) selectedDids.add(d.did);
        });
        hasStoredSelection = true;
      }

      persistSelectedDids();
      renderDevices();
    } else {
      container.innerHTML = `<div class="empty-hint">加载失败: ${escapeHtml(json.error || '未授权或连接失败')}</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-hint">请求失败: ${escapeHtml(err.message)}</div>`;
  }
}

function renderDevices() {
  const container = document.getElementById('device-list');
  container.innerHTML = '';

  devices.forEach((dev) => {
    const isSelected = selectedDids.has(dev.did);
    const playState = activeQueues[dev.did];
    const isDevicePlaying = !!playState;
    const isGateway = !!dev.is_gateway;
    const isIgnored = !!dev.is_ignored;

    const item = document.createElement('div');
    item.className = `device-item ${isSelected ? 'selected' : ''} ${isDevicePlaying ? 'is-playing' : ''} ${isIgnored ? 'is-ignored' : ''}`;
    item.innerHTML = `
      <div class="device-checkbox">
        <input type="checkbox" ${isSelected ? 'checked' : ''} data-did="${dev.did}" />
      </div>
      <div class="device-info">
        <div class="device-name-row">
          <span class="device-name">${escapeHtml(dev.name || dev.alias || dev.did)}</span>
          ${isGateway ? '<span class="badge badge-warning" style="font-size:11px;padding:2px 6px;border-radius:4px;background:#f59e0b;color:#fff;margin-left:4px;">🌟 主网关</span>' : ''}
          ${isIgnored ? '<span class="badge badge-danger" style="font-size:11px;padding:2px 6px;border-radius:4px;background:#ef4444;color:#fff;margin-left:4px;">🚫 已屏蔽</span>' : ''}
          <span class="device-model">${escapeHtml(dev.model || '小爱音箱')}</span>
        </div>
        ${
          isDevicePlaying
            ? `<div class="device-playing-song">🎵 正在播放: <strong>${escapeHtml(playState.music.name)}</strong> - ${escapeHtml(playState.music.singer)}</div>`
            : ''
        }
        <div class="device-actions" style="margin-top:6px;display:flex;gap:6px;">
          ${!isGateway ? `<button class="btn-action-small" onclick="handleSetGateway(event, '${dev.did}')" style="font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid #3b82f6;background:transparent;color:#60a5fa;cursor:pointer;">⭐ 设为主网关</button>` : ''}
          <button class="btn-action-small" onclick="handleToggleIgnore(event, '${dev.did}', ${isIgnored ? 0 : 1})" style="font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid #64748b;background:transparent;color:#94a3b8;cursor:pointer;">
            ${isIgnored ? '👁️ 取消屏蔽' : '🚫 屏蔽设备'}
          </button>
        </div>
      </div>
      <div class="device-status-tag ${isDevicePlaying ? 'playing' : ''}">${isDevicePlaying ? '▶️ 播放中' : dev.online !== false ? '在线' : '离线'}</div>
    `;

    const applySelection = (checked) => {
      if (checked) {
        selectedDids.add(dev.did);
        item.classList.add('selected');
      } else {
        selectedDids.delete(dev.did);
        item.classList.remove('selected');
      }
      persistSelectedDids();
      updateSelectionSummary();
    };

    item.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      const cb = item.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
      applySelection(cb.checked);
    });

    const checkbox = item.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', (e) => applySelection(e.target.checked));

    container.appendChild(item);
  });

  updateSelectionSummary();
}

/** Keep the "n / m selected" hint in sync with the checkboxes. */
function updateSelectionSummary() {
  const el = document.getElementById('selection-summary');
  if (!el) return;
  const total = devices.length;
  const picked = devices.filter((d) => selectedDids.has(d.did)).length;
  el.textContent = total === 0 ? '' : `已选 ${picked} / ${total}`;
  el.className = picked === 0 ? 'selection-summary is-empty' : 'selection-summary';
}

window.handleSetGateway = async function(e, did) {
  e.stopPropagation();
  await withButtonLoading(e.currentTarget, '设置中', async () => {
    try {
      const res = await authFetch('/api/user/speakers/gateway', {
        method: 'POST',
        body: JSON.stringify({ did })
      });
      const json = await res.json();
      if (json.ok) {
        showToast('已成功设为主点歌网关音箱', 'success');
        await fetchDevices();
      } else {
        showToast(json.error || '设置失败', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
};

window.handleToggleIgnore = async function(e, did, isIgnored) {
  e.stopPropagation();
  await withButtonLoading(e.currentTarget, '处理中', async () => {
    try {
      const res = await authFetch('/api/user/speakers/ignore', {
        method: 'POST',
        body: JSON.stringify({ did, isIgnored })
      });
      const json = await res.json();
      if (json.ok) {
        showToast(isIgnored ? '已屏蔽该音箱设备' : '已取消设备屏蔽', 'info');
        await fetchDevices();
      } else {
        showToast(json.error || '操作失败', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
};

function selectAllDevices() {
  devices.forEach((d) => selectedDids.add(d.did));
  persistSelectedDids();
  renderDevices();
}

function deselectAllDevices() {
  selectedDids.clear();
  hasStoredSelection = true;
  persistSelectedDids();
  renderDevices();
}

// 4. 发送 TTS 语音播报
async function sendTTS() {
  const text = document.getElementById('tts-input').value.trim();
  if (!text) {
    showToast('请输入要播报的文本内容', 'warning');
    return;
  }

  const targetDids = Array.from(selectedDids);
  if (targetDids.length === 0) {
    showToast('请在左侧至少勾选一台小爱音箱', 'warning');
    return;
  }

  const chime = document.getElementById('tts-chime-select')?.value || 'dingdong';

  await withButtonLoading('btn-send-tts', '播报发送中', async () => {
    try {
      const res = await authFetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, dids: targetDids, chime }),
      });
      const json = await res.json();
      if (json.ok) {
        showToast(`📢 已向 ${targetDids.length} 台音箱下发语音播报`, 'success');
      } else {
        showToast(`播报失败: ${json.error}`, 'error');
      }
    } catch (err) {
      showToast(`请求异常: ${err.message}`, 'error');
    }
  });
}

// 5. 音乐搜索 (严格使用当前选定的音源渠道)
const PLATFORM_LABELS = { all: '聚合', kw: '酷我', tx: 'QQ', kg: '酷狗', mg: '咪咕', wy: '网易云' };

/**
 * Identifies the search whose results the panel is currently allowed to show.
 * An aggregated search waits on five platforms at once, so switching to a
 * single platform afterwards can easily answer first — without this guard the
 * slower earlier response lands last and overwrites the newer results.
 */
let latestSearchKey = '';

async function doSearch() {
  const keyword = document.getElementById('search-input').value.trim();
  if (!keyword) {
    showToast('请输入歌名或歌手', 'warning');
    return;
  }

  const container = document.getElementById('search-results');
  const source = activeSearchSource || 'all';
  const sourceName = availableSources.find((s) => s.id === source)?.name || source;
  const searchKey = `${source}__${keyword}`;
  latestSearchKey = searchKey;

  container.innerHTML = `
    <div class="search-loading">
      <span class="btn-spinner big" aria-hidden="true"></span>
      <div>正在通过「${escapeHtml(sourceName)}」搜索…</div>
    </div>
  `;

  await withButtonLoading('btn-search', '搜索中', async () => {
    try {
      const res = await authFetch(
        `/api/search?keyword=${encodeURIComponent(keyword)}&limit=20&source=${encodeURIComponent(source)}`
      );
      const json = await res.json();

      // A newer search has been issued since this one started — drop the result.
      if (searchKey !== latestSearchKey) return;

      if (json.ok && json.data?.list?.length > 0) {
        container.innerHTML = '';
        json.data.list.forEach((song) => {
          const item = document.createElement('div');
          item.className = 'song-item';
          const platformLabel = PLATFORM_LABELS[song.source] || song.source || '';
          item.innerHTML = `
            <div class="song-info">
              <div class="song-title">
                ${escapeHtml(song.name)}
                ${platformLabel ? `<span class="song-source-tag source-${escapeHtml(song.source)}">${escapeHtml(platformLabel)}</span>` : ''}
              </div>
              <div class="song-meta">${escapeHtml(song.singer)} • ${escapeHtml(song.albumName || '单曲')} • ${escapeHtml(song.interval || '')}</div>
            </div>
            <button class="btn-cast">🔊 投播小爱</button>
          `;

          const castBtn = item.querySelector('.btn-cast');
          castBtn.addEventListener('click', () => castSong(song, castBtn));
          container.appendChild(item);
        });
      } else if (json.ok) {
        container.innerHTML = `
          <div class="empty-hint">
            <div class="empty-hint-icon">🕳️</div>
            <div>「${escapeHtml(sourceName)}」下未搜索到「${escapeHtml(keyword)}」</div>
            <div class="empty-hint-sub">可切换其他音源渠道，或改用聚合搜索</div>
          </div>
        `;
      } else {
        container.innerHTML = `<div class="empty-hint">搜索失败: ${escapeHtml(json.error || '未知错误')}</div>`;
      }
    } catch (err) {
      if (searchKey !== latestSearchKey) return;
      container.innerHTML = `<div class="empty-hint">搜索失败: ${escapeHtml(err.message)}</div>`;
    }
  });
}

// 6. 投播歌曲到小爱音箱
async function castSong(music, triggerBtn) {
  const targetDids = Array.from(selectedDids);
  if (targetDids.length === 0) {
    showToast('请在左侧至少勾选一台小爱音箱', 'warning');
    return;
  }

  await withButtonLoading(triggerBtn, '投播中', async () => {
    try {
      const res = await authFetch('/api/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ music, dids: targetDids }),
      });
      const json = await res.json();
      if (json.ok) {
        document.getElementById('player-title').textContent = music.name;
        document.getElementById('player-artist').textContent = music.singer;
        isPlaying = true;
        document.getElementById('btn-toggle-play').textContent = '⏸️';
        showToast(`🎵 正在投播: ${music.singer} - ${music.name}`, 'success');
        setTimeout(fetchStatus, 1200);
      } else {
        showToast(`投播失败: ${json.error}`, 'error');
      }
    } catch (err) {
      showToast(`投播异常: ${err.message}`, 'error');
    }
  });
}

// 7. 播放控制 (针对当前勾选的所有音箱)
async function controlPlay(action) {
  const targetDids = Array.from(selectedDids);
  if (targetDids.length === 0) {
    showToast('请先勾选要控制的小爱音箱', 'warning');
    return;
  }
  if (action === 'pause') {
    isPlaying = false;
    const btnPlay = document.getElementById('btn-toggle-play');
    if (btnPlay) btnPlay.textContent = '▶️';
    showToast('⏸️ 已暂停播放', 'info', 2000);
  } else if (action === 'resume') {
    isPlaying = true;
    const btnPlay = document.getElementById('btn-toggle-play');
    if (btnPlay) btnPlay.textContent = '⏸️';
    showToast('▶️ 已恢复播放', 'info', 2000);
  } else if (action === 'stop') {
    isPlaying = false;
    const btnPlay = document.getElementById('btn-toggle-play');
    if (btnPlay) btnPlay.textContent = '▶️';
    showToast('⏹️ 已停止播放', 'info', 2000);
  }

  const controls = document.getElementById('player-bar');
  controls?.classList.add('is-busy');
  try {
    await authFetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, dids: targetDids }),
    });
    setTimeout(fetchStatus, 400);
  } catch (err) {
    showToast(`控制失败: ${err.message}`, 'error');
  } finally {
    controls?.classList.remove('is-busy');
  }
}

// 8. 独立控制单台指定音箱
window.controlSingleSpeaker = async function (did, action) {
  const dev = devices.find(d => d.did === did);
  const devName = dev?.name || dev?.alias || did;
  const actionTexts = { pause: '已暂停', resume: '已恢复播放', stop: '已停止', next: '已切下一首' };
  if (actionTexts[action]) {
    showToast(`🔊 [${devName}] ${actionTexts[action]}`, 'info', 2000);
  }

  try {
    await authFetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, did }),
    });
    setTimeout(fetchStatus, 400);
  } catch (err) {
    showToast(`单音箱控制失败: ${err.message}`, 'error');
  }
};

