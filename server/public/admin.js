const token = localStorage.getItem('soundhub_token');
if (!token) {
  window.location.href = '/login';
}

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

function adminLogout() {
  localStorage.removeItem('soundhub_token');
  localStorage.removeItem('soundhub_user');
  window.location.href = '/login';
}

function switchAdminTab(tab) {
  document.getElementById('btn-tab-users').className = 'admin-nav-btn ' + (tab === 'users' ? 'active' : '');
  document.getElementById('btn-tab-settings').className = 'admin-nav-btn ' + (tab === 'settings' ? 'active' : '');
  document.getElementById('panel-users').style.display = tab === 'users' ? 'block' : 'none';
  document.getElementById('panel-settings').style.display = tab === 'settings' ? 'block' : 'none';
}

async function loadAdminOverview() {
  try {
    const res = await fetch('/api/admin/overview', { headers: { 'Authorization': 'Bearer ' + token } });
    if (res.status === 401 || res.status === 403) {
      showToast('权限不足，需要超级管理员身份', 'error');
      setTimeout(() => { window.location.href = '/app'; }, 1000);
      return;
    }
    const json = await res.json();
    if (json.ok) {
      document.getElementById('stat-total-users').innerText = json.data.totalUsers;
      document.getElementById('stat-pro-users').innerText = json.data.proUsers;
      document.getElementById('stat-bound-accs').innerText = json.data.totalBoundMiAccounts;
      document.getElementById('stat-settings-count').innerText = json.data.systemSettingsCount;
    }
  } catch (e) {
    console.error(e);
  }
}

async function loadUsers() {
  try {
    const res = await fetch('/api/admin/users', { headers: { 'Authorization': 'Bearer ' + token } });
    const json = await res.json();
    if (json.ok) {
      const tbody = document.getElementById('users-tbody');
      if (json.data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">暂无租户</td></tr>';
        return;
      }
      tbody.innerHTML = json.data.map(u => `
        <tr>
          <td>
            <strong>${escapeHtml(u.username)}</strong>
            ${u.role === 'admin' ? '<span class="badge" style="background:#ff6a00;color:#fff;font-size:10px;padding:2px 4px;border-radius:3px;margin-left:4px;">ADMIN</span>' : ''}
            <div style="font-size: 11px; color: var(--text-muted); font-family: monospace;">${u.id}</div>
          </td>
          <td><span class="plan-badge plan-${u.plan}">${u.plan}</span></td>
          <td>${u.max_devices} 台</td>
          <td>${u.has_mi_account ? '✅ 已绑定 (' + (u.speaker_count || 0) + '台音箱)' : '<span style="color:var(--text-muted);">未绑定</span>'}</td>
          <td>${u.expires_at ? new Date(u.expires_at).toLocaleDateString() : '永久有效'}</td>
          <td>${new Date(u.created_at).toLocaleDateString()}</td>
          <td>
            <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="openPlanModal('${u.id}', '${u.plan}', ${u.max_devices})">调整套餐/授权</button>
          </td>
        </tr>
      `).join('');
    }
  } catch (e) {
    console.error(e);
  }
}

function openPlanModal(userId, currentPlan, maxDevices) {
  document.getElementById('modal-user-id').value = userId;
  document.getElementById('modal-plan-select').value = currentPlan;
  document.getElementById('modal-max-devices').value = maxDevices || 10;
  document.getElementById('plan-modal').style.display = 'flex';
}

function closePlanModal() {
  document.getElementById('plan-modal').style.display = 'none';
}

async function submitPlanChange() {
  const userId = document.getElementById('modal-user-id').value;
  const plan = document.getElementById('modal-plan-select').value;
  const durationDays = document.getElementById('modal-plan-days').value;
  const maxDevices = document.getElementById('modal-max-devices').value;

  try {
    const res = await fetch('/api/admin/users/plan', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ userId, plan, durationDays, maxDevices })
    });
    const json = await res.json();
    if (json.ok) {
      showToast(json.msg, 'success');
      closePlanModal();
      loadUsers();
      loadAdminOverview();
    } else {
      showToast(json.error || '操作失败', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
}

let cachedSettings = [];
let availableSources = [];

async function loadSystemSettings() {
  try {
    try {
      const srcRes = await fetch('/api/admin/sources', { headers: { 'Authorization': 'Bearer ' + token } });
      const srcJson = await srcRes.json();
      if (srcJson.ok) availableSources = srcJson.data || [];
    } catch {}

    const res = await fetch('/api/admin/settings', { headers: { 'Authorization': 'Bearer ' + token } });
    const json = await res.json();
    if (json.ok) {
      cachedSettings = json.data;
      const container = document.getElementById('settings-form-container');
      container.innerHTML = json.data.map(s => {
        let inputHtml = '';
        if (s.key === 'active_source') {
          const sources = availableSources.length > 0 ? availableSources : ['my-custom-source.js'];
          inputHtml = `
            <select id="setting-input-${s.key}" style="width:100%;box-sizing:border-box;padding:10px;background:#1a1a24;border:1px solid var(--border-color);color:#fff;border-radius:6px;font-size:14px;">
              ${sources.map(src => `<option value="${src}" ${src === s.value ? 'selected' : ''}>🎵 ${src}</option>`).join('')}
            </select>
          `;
        } else if (s.key === 'enable_listener' || s.key === 'allow_registration') {
          inputHtml = `
            <select id="setting-input-${s.key}" style="width:100%;box-sizing:border-box;padding:10px;background:#1a1a24;border:1px solid var(--border-color);color:#fff;border-radius:6px;font-size:14px;">
              <option value="true" ${s.value === 'true' ? 'selected' : ''}>✅ 开启 (true)</option>
              <option value="false" ${s.value === 'false' ? 'selected' : ''}>⛔ 关闭 (false)</option>
            </select>
          `;
        } else if (s.key === 'default_platform') {
          inputHtml = `
            <select id="setting-input-${s.key}" style="width:100%;box-sizing:border-box;padding:10px;background:#1a1a24;border:1px solid var(--border-color);color:#fff;border-radius:6px;font-size:14px;">
              <option value="kw" ${s.value === 'kw' ? 'selected' : ''}>酷我音乐 (kw - 推荐)</option>
              <option value="wy" ${s.value === 'wy' ? 'selected' : ''}>网易云音乐 (wy)</option>
              <option value="tx" ${s.value === 'tx' ? 'selected' : ''}>QQ音乐 (tx)</option>
              <option value="kg" ${s.value === 'kg' ? 'selected' : ''}>酷狗音乐 (kg)</option>
              <option value="mg" ${s.value === 'mg' ? 'selected' : ''}>咪咕音乐 (mg)</option>
            </select>
          `;
        } else {
          inputHtml = `<input type="text" id="setting-input-${s.key}" value="${escapeHtml(s.value)}" style="width: 100%; box-sizing: border-box; padding: 10px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); color: #fff; border-radius: 6px; font-size: 14px;">`;
        }

        return `
          <div style="margin-bottom: 16px; padding-bottom: 14px; border-bottom: 1px solid var(--border-color);">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <strong style="font-size: 14px;">${escapeHtml(s.description || s.key)}</strong>
              <span style="font-family: monospace; font-size: 12px; color: var(--text-muted);">${s.key} (${s.category})</span>
            </div>
            ${inputHtml}
          </div>
        `;
      }).join('');
    }
  } catch (e) {
    console.error(e);
  }
}

async function saveSystemSettings() {
  const updated = cachedSettings.map(s => {
    const input = document.getElementById('setting-input-' + s.key);
    return { key: s.key, value: input ? input.value : s.value };
  });

  try {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ settings: updated })
    });
    const json = await res.json();
    if (json.ok) {
      showToast('🎉 ' + json.msg, 'success');
      loadSystemSettings();
    } else {
      showToast(json.error || '保存失败', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

loadAdminOverview();
loadUsers();
loadSystemSettings();
