/**
 * XiaoAi SoundHub Web 控制台前端交互逻辑
 */

let devices = [];
let selectedDids = new Set();
let isPlaying = false;

// 1. 初始化
document.addEventListener('DOMContentLoaded', () => {
  fetchStatus();
  fetchDevices();
  bindEvents();

  // 定时拉取播放状态
  setInterval(fetchStatus, 4000);
});

function bindEvents() {
  document.getElementById('btn-refresh-devices').addEventListener('click', fetchDevices);
  document.getElementById('btn-select-all').addEventListener('click', selectAllDevices);
  document.getElementById('btn-deselect-all').addEventListener('click', deselectAllDevices);
  document.getElementById('btn-send-tts').addEventListener('click', sendTTS);
  document.getElementById('btn-search').addEventListener('click', doSearch);
  document.getElementById('search-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') doSearch();
  });

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
  document.getElementById('btn-toggle-play').addEventListener('click', () => controlPlay(isPlaying ? 'pause' : 'resume'));
  document.getElementById('btn-next').addEventListener('click', () => controlPlay('next'));
  document.getElementById('btn-prev').addEventListener('click', () => controlPlay('prev'));
  document.getElementById('btn-stop').addEventListener('click', () => controlPlay('stop'));
}

// 2. 状态查询
async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const json = await res.json();
    if (json.ok) {
      document.getElementById('status-text').textContent = '服务在线';
      document.getElementById('active-source-badge').textContent = `音源: ${json.data.activeSource}`;
      
      const current = json.data.currentPlayState;
      if (current && current.music) {
        document.getElementById('player-title').textContent = current.music.name;
        document.getElementById('player-artist').textContent = current.music.singer;
        isPlaying = true;
        document.getElementById('btn-toggle-play').textContent = '⏸️';
      } else {
        isPlaying = false;
        document.getElementById('btn-toggle-play').textContent = '▶️';
      }
    }
  } catch {
    document.getElementById('status-text').textContent = '连接中断';
  }
}

// 3. 拉取设备列表
async function fetchDevices() {
  const container = document.getElementById('device-list');
  container.innerHTML = '<div class="empty-hint">正在拉取设备列表...</div>';

  try {
    const res = await fetch('/api/devices');
    const json = await res.json();

    if (json.ok && json.data) {
      devices = json.data;
      document.getElementById('device-count').textContent = devices.length;

      if (devices.length === 0) {
        container.innerHTML = '<div class="empty-hint">未发现音箱，请在 config.json 检查小米账号配置</div>';
        return;
      }

      // 默认全选
      devices.forEach((d) => selectedDids.add(d.did));
      renderDevices();
    } else {
      container.innerHTML = `<div class="empty-hint">加载失败: ${json.error || '未知错误'}</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-hint">网络异常: ${err.message}</div>`;
  }
}

function renderDevices() {
  const container = document.getElementById('device-list');
  container.innerHTML = '';

  devices.forEach((dev) => {
    const isSelected = selectedDids.has(dev.did);
    const item = document.createElement('div');
    item.className = `device-item ${isSelected ? 'selected' : ''}`;
    item.innerHTML = `
      <div class="device-info">
        <input type="checkbox" ${isSelected ? 'checked' : ''} />
        <div>
          <div class="device-name">${dev.name}</div>
          <div class="device-model">${dev.model || '小爱音箱'}</div>
        </div>
      </div>
      <div class="device-status-tag">${dev.online !== false ? '在线' : '离线'}</div>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT') {
        const checkbox = item.querySelector('input');
        checkbox.checked = !checkbox.checked;
      }
      if (selectedDids.has(dev.did)) {
        selectedDids.delete(dev.did);
        item.classList.remove('selected');
      } else {
        selectedDids.add(dev.did);
        item.classList.add('selected');
      }
    });

    container.appendChild(item);
  });
}

function selectAllDevices() {
  devices.forEach((d) => selectedDids.add(d.did));
  renderDevices();
}

function deselectAllDevices() {
  selectedDids.clear();
  renderDevices();
}

// 4. 发送 TTS 语音播报
async function sendTTS() {
  const text = document.getElementById('tts-input').value.trim();
  if (!text) {
    alert('请输入播报文本');
    return;
  }

  const targetDids = Array.from(selectedDids);
  if (targetDids.length === 0) {
    alert('请至少勾选一台小爱音箱');
    return;
  }

  const btn = document.getElementById('btn-send-tts');
  btn.disabled = true;
  btn.textContent = '播报发送中...';

  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, dids: targetDids }),
    });
    const json = await res.json();
    if (json.ok) {
      alert('📢 语音播报指令已下发成功！');
    } else {
      alert(`播报失败: ${json.error}`);
    }
  } catch (err) {
    alert(`请求异常: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '📢 发送语音播报 (所选音箱)';
  }
}

// 5. 音乐搜索
async function doSearch() {
  const keyword = document.getElementById('search-input').value.trim();
  if (!keyword) return;

  const container = document.getElementById('search-results');
  container.innerHTML = '<div class="empty-hint">🔍 正在通过 LX 音源搜索全网曲库...</div>';

  try {
    const res = await fetch(`/api/search?keyword=${encodeURIComponent(keyword)}&limit=20`);
    const json = await res.json();

    if (json.ok && json.data?.list?.length > 0) {
      container.innerHTML = '';
      json.data.list.forEach((song) => {
        const item = document.createElement('div');
        item.className = 'song-item';
        item.innerHTML = `
          <div class="song-info">
            <div class="song-title">${song.name}</div>
            <div class="song-meta">${song.singer} • ${song.albumName || '单曲'} • ${song.interval}</div>
          </div>
          <button class="btn-cast">🔊 投播小爱</button>
        `;

        item.querySelector('.btn-cast').addEventListener('click', () => castSong(song));
        container.appendChild(item);
      });
    } else {
      container.innerHTML = '<div class="empty-hint">未搜索到相关歌曲</div>';
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-hint">搜索失败: ${err.message}</div>`;
  }
}

// 6. 投播歌曲到小爱音箱
async function castSong(music) {
  const targetDids = Array.from(selectedDids);
  if (targetDids.length === 0) {
    alert('请在左侧勾选要投播的小爱音箱');
    return;
  }

  try {
    const res = await fetch('/api/play', {
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
    } else {
      alert(`投播失败: ${json.error}`);
    }
  } catch (err) {
    alert(`投播异常: ${err.message}`);
  }
}

// 7. 播放控制
async function controlPlay(action) {
  const targetDid = Array.from(selectedDids)[0] || '';
  try {
    await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, did: targetDid }),
    });
    setTimeout(fetchStatus, 500);
  } catch (err) {
    console.error('控制失败:', err);
  }
}

