'use strict';

/* 星期衣精致洗衣衣物照片系统 · 渲染进程（Vue 3 全局构建，无需构建工具） */

const { createApp } = Vue;

/* ---------- 通用工具 ---------- */
const toastState = { timer: null };

function toast(msg, type) {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show ' + (type || 'success');
  clearTimeout(toastState.timer);
  toastState.timer = setTimeout(() => {
    el.className = 'toast';
  }, 2600);
}

function fmt(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  );
}

/* ---------- 启动设置页（首次使用 / 切换运行模式） ---------- */
const SetupPage = {
  emits: ['done'],
  setup(props, { emit }) {
    const info = Vue.ref(null);
    const localIp = Vue.ref('');
    const tab = Vue.ref('server');
    const serverUrl = Vue.ref('');
    const serverToken = Vue.ref('');
    const testing = Vue.ref(false);
    const testMsg = Vue.ref('');

    async function load() {
      const r = await window.api.systemInfo();
      if (r.ok) {
        info.value = r.data;
        tab.value = r.data.mode === 'client' ? 'client' : 'server';
        if (r.data.serverUrl) serverUrl.value = r.data.serverUrl;
      }
      const ip = await window.api.localIp();
      if (ip.ok) localIp.value = ip.data;
    }

    async function asServer() {
      const r = await window.api.setMode('server');
      if (r.ok) {
        toast('已配置为服务端，请重启应用生效', 'success');
        emit('done');
      } else {
        toast(r.message || '保存失败', 'error');
      }
    }

    async function testConn() {
      testing.value = true;
      testMsg.value = '';
      const r = await window.api.testServer(serverUrl.value, serverToken.value);
      testing.value = false;
      testMsg.value = r.ok ? '✓ 连接成功，服务器在线' : '✗ ' + (r.message || '连接失败');
      return r.ok;
    }

    async function asClient() {
      const ok = await testConn();
      if (!ok) return;
      const r = await window.api.setClientConfig(serverUrl.value, serverToken.value);
      if (r.ok) {
        toast('已配置为客户端，请重启应用生效', 'success');
        emit('done');
      } else {
        toast(r.message || '保存失败', 'error');
      }
    }

    Vue.onMounted(load);
    return { info, localIp, tab, serverUrl, serverToken, testing, testMsg, asServer, asClient, testConn };
  },
  template: `
    <div class="setup-wrap">
      <div class="setup-card">
        <div class="login-logo">👕</div>
        <h1>星期衣精致洗衣 · 衣物照片系统</h1>
        <div class="login-sub">首次使用，请选择本机的运行模式</div>

        <div class="setup-tabs">
          <div class="setup-tab" :class="{ active: tab === 'server' }" @click="tab = 'server'">🖥️ 作为服务端</div>
          <div class="setup-tab" :class="{ active: tab === 'client' }" @click="tab = 'client'">💻 作为客户端</div>
        </div>

        <div v-if="tab === 'server'" class="setup-body">
          <p class="setup-desc">
            本电脑作为数据中枢：账号、存档记录、操作日志与照片全部保存在本机，
            并开启局域网服务供其他电脑连接。跨城市使用时请配合异地组网或内网穿透工具。
          </p>
          <div v-if="info" class="setup-info">
            <div class="info-row"><span>服务端口</span><b>{{ info.port }}</b></div>
            <div class="info-row"><span>连接码</span><b class="code">{{ info.token }}</b></div>
            <div class="info-row"><span>本机局域网 IP</span><b>{{ localIp }}</b></div>
          </div>
          <button class="btn btn-primary btn-block" @click="asServer">保存并作为服务端运行</button>
        </div>

        <div v-else class="setup-body">
          <p class="setup-desc">
            本电脑作为工作站：连接到已有的服务端，拍照与查询都实时读写服务器数据。
            请先向服务端管理员获取服务器地址与连接码。
          </p>
          <label>服务器地址</label>
          <input v-model="serverUrl" placeholder="例如 http://192.168.1.10:17521" />
          <label>连接码</label>
          <input v-model="serverToken" placeholder="服务端「系统设置」页中的连接码" />
          <div v-if="testMsg" class="setup-test" :class="{ ok: testMsg.indexOf('✓') === 0 }">{{ testMsg }}</div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-ghost" style="flex:1" :disabled="testing" @click="testConn">
              {{ testing ? '测试中…' : '测试连接' }}
            </button>
            <button class="btn btn-primary" style="flex:1" :disabled="testing" @click="asClient">保存并连接</button>
          </div>
        </div>

        <div class="login-hint">配置保存后需重启应用生效；之后可在管理端「系统设置」中重新切换</div>
      </div>
    </div>
  `
};

/* ---------- 登录页 ---------- */
const LoginPage = {
  props: { sysInfo: { type: Object, default: null } },
  emits: ['login', 'server-saved'],
  setup(props, { emit }) {
    const username = Vue.ref('');
    const password = Vue.ref('');
    const error = Vue.ref('');
    const loading = Vue.ref(false);

    const showServer = Vue.ref(false);
    const serverUrl = Vue.ref('');
    const serverToken = Vue.ref('');
    const testing = Vue.ref(false);
    const testMsg = Vue.ref('');
    const savingServer = Vue.ref(false);

    function openServer() {
      showServer.value = !showServer.value;
      if (showServer.value && props.sysInfo) {
        serverUrl.value = props.sysInfo.serverUrl || '';
      }
      testMsg.value = '';
    }

    async function testConn() {
      testing.value = true;
      testMsg.value = '';
      const r = await window.api.testServer(serverUrl.value, serverToken.value);
      testing.value = false;
      testMsg.value = r.ok ? '✓ 连接成功，服务器在线' : '✗ ' + (r.message || '连接失败');
      return r.ok;
    }

    async function saveServer() {
      savingServer.value = true;
      try {
        const ok = await testConn();
        if (!ok) return;
        const r = await window.api.setClientConfig(serverUrl.value, serverToken.value);
        if (r.ok) {
          toast('服务器设置已保存并生效', 'success');
          showServer.value = false;
          emit('server-saved');
        } else {
          toast(r.message || '保存失败', 'error');
        }
      } finally {
        savingServer.value = false;
      }
    }

    async function submit() {
      if (loading.value) return;
      error.value = '';
      if (!username.value.trim() || !password.value) {
        error.value = '请输入账号和密码';
        return;
      }
      loading.value = true;
      try {
        const r = await window.api.login(username.value.trim(), password.value);
        if (r.ok) {
          toast('登录成功，欢迎 ' + (r.data.user.name || r.data.user.username), 'success');
          emit('login', r.data);
        } else {
          error.value = r.message || '登录失败';
        }
      } catch (e) {
        error.value = '登录失败：' + (e.message || e);
      } finally {
        loading.value = false;
      }
    }

    return {
      username, password, error, loading, submit,
      showServer, serverUrl, serverToken, testing, testMsg, savingServer,
      openServer, testConn, saveServer, sysInfo: props.sysInfo
    };
  },
  template: `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-logo">👕</div>
        <h1>星期衣精致洗衣</h1>
        <div class="login-sub">衣物照片系统</div>
        <form @submit.prevent="submit">
          <label>账号</label>
          <input v-model="username" placeholder="请输入账号" autocomplete="username" />
          <label>密码</label>
          <input v-model="password" type="password" placeholder="请输入密码" autocomplete="current-password" />
          <div v-if="error" class="form-error">{{ error }}</div>
          <button class="btn btn-primary btn-block" type="submit" :disabled="loading">
            {{ loading ? '登录中…' : '登 录' }}
          </button>
        </form>

        <div class="login-server-toggle" @click="openServer">
          ⚙️ 服务器设置
          <span v-if="sysInfo && sysInfo.mode === 'client'" class="tag tag-green" style="margin-left:6px">客户端</span>
          <span v-else-if="sysInfo && sysInfo.mode === 'server'" class="tag tag-orange" style="margin-left:6px">本机服务端</span>
        </div>

        <div v-if="showServer" class="login-server-panel">
          <template v-if="sysInfo && sysInfo.mode === 'server'">
            <div class="setup-desc">
              本机正在以服务端模式运行，账号与照片数据存储在本机，无需连接其他服务器。
              如需改为连接远程服务器，请在下方填写后保存。
            </div>
          </template>
          <label>服务器地址</label>
          <input v-model="serverUrl" placeholder="例如 http://192.168.1.10:17521" />
          <label>连接码</label>
          <input v-model="serverToken" placeholder="服务端「系统设置」页中的连接码" />
          <div v-if="testMsg" class="setup-test" :class="{ ok: testMsg.indexOf('✓') === 0 }">{{ testMsg }}</div>
          <div style="display:flex;gap:10px;margin-top:12px">
            <button class="btn btn-ghost" style="flex:1" :disabled="testing || savingServer" @click="testConn">
              {{ testing ? '测试中…' : '测试连接' }}
            </button>
            <button class="btn btn-primary" style="flex:1" :disabled="testing || savingServer" @click="saveServer">
              {{ savingServer ? '保存中…' : '保存并生效' }}
            </button>
          </div>
        </div>

        <div class="login-hint">
          首次使用默认管理员账号：admin / admin123<br />
          登录后请及时修改密码并创建店员账号
        </div>
      </div>
    </div>
  `
};

/* ---------- 客户端 · 首页 ---------- */
const HomePage = {
  props: { user: { type: Object, required: true }, token: { type: String, required: true } },
  emits: ['goto'],
  setup(props) {
    const stats = Vue.ref({ myCount: 0, todayCount: 0 });
    const recent = Vue.ref([]);
    const detail = Vue.ref(null);

    async function load() {
      const r = await window.api.listRecords(props.token, { page: 1, pageSize: 100, silent: true });
      if (r.ok) {
        recent.value = r.data.items.slice(0, 6);
        const today = new Date().toISOString().slice(0, 10);
        stats.value.todayCount = r.data.items.filter((x) => x.createdAt.slice(0, 10) === today).length;
        stats.value.myCount = r.data.total;
      }
    }

    async function openDetail(r) {
      const res = await window.api.getRecord(props.token, r.id);
      if (res.ok) detail.value = res.data;
      else toast(res.message || '打开失败', 'error');
    }

    Vue.onMounted(load);
    return { user: props.user, stats, recent, detail, openDetail, fmt };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>你好，{{ user.name || user.username }}</h2>
        <p>欢迎使用星期衣精致洗衣衣物照片系统，收衣拍照留存，取衣核对更放心</p>
      </div>

      <div class="stat-row">
        <div class="stat-card"><div class="lbl">我的存档总数</div><div class="num">{{ stats.myCount }}</div></div>
        <div class="stat-card"><div class="lbl">今日新增（最近 100 条内）</div><div class="num">{{ stats.todayCount }}</div></div>
        <div class="stat-card"><div class="lbl">当前账号</div><div class="num" style="font-size:19px;padding-top:10px">{{ user.username }}</div></div>
      </div>

      <div class="quick-row">
        <button class="quick-card" @click="$emit('goto', 'capture')">
          <div class="t">📷 衣物拍照</div>
          <div class="d">扫描或输入衣物条形码，拍摄最大分辨率照片存档</div>
        </button>
        <button class="quick-card" @click="$emit('goto', 'query')">
          <div class="t">🔍 记录查询</div>
          <div class="d">按条形码、备注、日期查找已存档的照片</div>
        </button>
      </div>

      <h3 class="section-title">最近存档</h3>
      <div v-if="!recent.length" class="card empty">还没有存档记录，去「衣物拍照」添加第一张照片吧</div>
      <div v-else class="record-grid">
        <div v-for="r in recent" :key="r.id" class="record-card" @click="openDetail(r)">
          <div class="record-photo"><img :src="r.photoUrl" /></div>
          <div class="record-meta">
            <div class="record-customer">{{ r.barcode }}</div>
            <div class="record-tags">
              <span class="tag tag-orange">第 {{ r.seq }} 张</span>
            </div>
            <div class="record-time">{{ fmt(r.createdAt) }}</div>
          </div>
        </div>
      </div>

      <div v-if="detail" class="modal-mask" @click.self="detail = null">
        <div class="modal">
          <div class="modal-head"><h3>存档详情</h3><button class="modal-close" @click="detail = null">✕</button></div>
          <div class="modal-body">
            <img class="modal-photo" :src="detail.photoUrl" />
            <div class="info-row"><span>条形码</span><b>{{ detail.barcode }}</b></div>
            <div class="info-row"><span>照片编号</span><b>第 {{ detail.seq }} 张</b></div>
            <div class="info-row"><span>备注</span><b>{{ detail.note || '无' }}</b></div>
            <div class="info-row"><span>拍摄时间</span><b>{{ fmt(detail.createdAt) }}</b></div>
          </div>
          <div class="modal-foot"><button class="btn btn-ghost" @click="detail = null">关闭</button></div>
        </div>
      </div>
    </div>
  `
};

/* ---------- 客户端 · 拍照页（最大分辨率 + 空格拍摄 + 连拍批量保存） ---------- */
const CapturePage = {
  props: { token: { type: String, required: true } },
  setup(props) {
    const stream = Vue.ref(null);
    const devices = Vue.ref([]);
    const deviceId = Vue.ref('');
    const cameraError = Vue.ref('');
    const resolution = Vue.ref('');
    const shots = Vue.ref([]); // 待保存的照片队列（dataURL）
    const barcode = Vue.ref('');
    const note = Vue.ref('');
    const saving = Vue.ref(false);
    const barcodeCount = Vue.ref(null);
    const videoEl = Vue.ref(null);
    const barcodeEl = Vue.ref(null);
    const ready = Vue.ref(false); // 条码已就绪、处于可拍摄状态

    async function loadDevices() {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        devices.value = list.filter((d) => d.kind === 'videoinput');
        if (devices.value.length && !deviceId.value) deviceId.value = devices.value[0].deviceId;
      } catch (e) {
        /* 忽略枚举失败 */
      }
    }

    // 应用连续自动对焦 + 近距对焦（拍衣物多为近景），不支持的设备静默忽略
    async function applyFocus(track) {
      if (!track || !track.getCapabilities || !track.applyConstraints) return;
      let cap = {};
      try {
        cap = track.getCapabilities();
      } catch (e) {
        return;
      }
      const adv = {};
      if (cap.focusMode && cap.focusMode.includes('continuous')) adv.focusMode = 'continuous';
      if (cap.focusDistance) adv.focusDistance = cap.focusDistance.min || undefined;
      if (Object.keys(adv).length) {
        try {
          await track.applyConstraints({ advanced: [adv] });
        } catch (e) {
          /* 部分设备不支持，保持默认对焦 */
        }
      }
    }

    async function startCamera(id) {
      cameraError.value = '';
      if (stream.value) {
        stream.value.getTracks().forEach((t) => t.stop());
        stream.value = null;
      }
      try {
        const constraints = { video: id ? { deviceId: { exact: id } } : true, audio: false };
        const s = await navigator.mediaDevices.getUserMedia(constraints);
        const track = s.getVideoTracks()[0];
        // 读取摄像头能力上限，按最大分辨率重新应用约束
        const cap = track.getCapabilities ? track.getCapabilities() : {};
        const maxW = cap.width && cap.width.max;
        const maxH = cap.height && cap.height.max;
        if (maxW && maxH && track.applyConstraints) {
          try {
            await track.applyConstraints({ width: { ideal: maxW }, height: { ideal: maxH } });
          } catch (e) {
            /* 部分摄像头不支持调整，保持当前分辨率 */
          }
        }
        const settings = track.getSettings();
        resolution.value = (settings.width || 0) + ' × ' + (settings.height || 0);
        stream.value = s;
        await Vue.nextTick();
        if (videoEl.value) {
          videoEl.value.srcObject = s;
          await videoEl.value.play();
          // 画面就绪后再次应用对焦，避免初始虚焦
          applyFocus(track);
        }
      } catch (e) {
        cameraError.value = '无法打开摄像头：' + (e.message || e.name);
      }
    }

    function capture() {
      if (saving.value) return;
      const v = videoEl.value;
      if (!v || !v.videoWidth) {
        toast('摄像头画面未就绪', 'error');
        return;
      }
      // 按摄像头当前（最大）分辨率绘制，不做缩放
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      canvas.getContext('2d').drawImage(v, 0, 0);
      shots.value.push(canvas.toDataURL('image/jpeg', 0.92));
      if (!resolution.value) resolution.value = v.videoWidth + ' × ' + v.videoHeight;
    }

    function removeShot(i) {
      shots.value.splice(i, 1);
    }

    function clearShots() {
      shots.value = [];
    }

    async function checkBarcodeCount() {
      if (!barcode.value.trim()) {
        barcodeCount.value = null;
        return;
      }
      const r = await window.api.listRecords(props.token, { barcode: barcode.value.trim(), silent: true, pageSize: 1 });
      if (r.ok) barcodeCount.value = r.data.total;
    }

    // 扫码枪扫入后会自动发送回车：核对条码并退出输入框，立即进入拍摄状态
    function onBarcodeDone() {
      checkBarcodeCount();
      ready.value = !!barcode.value.trim();
      if (barcodeEl.value && document.activeElement === barcodeEl.value) barcodeEl.value.blur();
    }

    async function saveAll() {
      if (saving.value) return;
      if (!barcode.value.trim()) {
        toast('请填写衣物条形码', 'error');
        return;
      }
      if (!shots.value.length) {
        toast('请先拍摄照片（空格键或点击「📸 拍照」）', 'error');
        return;
      }
      saving.value = true;
      try {
        let ok = 0;
        let lastSeq = 0;
        for (const s of shots.value) {
          const r = await window.api.addRecord(props.token, {
            imageData: s,
            barcode: barcode.value.trim(),
            note: note.value.trim()
          });
          if (r.ok) {
            ok++;
            lastSeq = r.data.seq;
          } else {
            break;
          }
        }
        if (ok === shots.value.length) {
          toast('已保存 ' + ok + ' 张：条码 ' + barcode.value.trim() + '，编至第 ' + lastSeq + ' 张', 'success');
          shots.value = [];
          note.value = '';
          // 保存完成后清空条码、重置状态，焦点回到条码框等待扫下一件
          barcode.value = '';
          ready.value = false;
          barcodeCount.value = null;
          focusBarcode();
        } else if (ok > 0) {
          shots.value = shots.value.slice(ok);
          barcodeCount.value = lastSeq;
          toast('已保存 ' + ok + ' 张，剩余照片保存失败，请重试', 'error');
        } else {
          toast('保存失败，请重试', 'error');
        }
      } catch (e) {
        toast('保存失败：' + (e.message || e), 'error');
      } finally {
        saving.value = false;
      }
    }

    // 快捷键：空格拍摄、回车保存；条码框内回车 = 确认条码并进入拍摄状态
    function onKeydown(e) {
      const t = e.target;
      const inBarcode = t === barcodeEl.value;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        if (inBarcode && e.key === 'Enter') {
          e.preventDefault();
          onBarcodeDone();
        }
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) capture();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        saveAll();
      }
    }

    function focusBarcode() {
      Vue.nextTick().then(() => {
        if (barcodeEl.value) barcodeEl.value.focus();
        // 个别环境下一次聚焦会被抢占，短延时再补一次
        setTimeout(() => {
          if (barcodeEl.value && document.activeElement !== barcodeEl.value) barcodeEl.value.focus();
        }, 80);
      });
    }

    Vue.watch(barcode, (v) => {
      if (!String(v || '').trim()) {
        ready.value = false;
        barcodeCount.value = null;
      }
    });

    function stopCamera() {
      if (stream.value) {
        stream.value.getTracks().forEach((t) => t.stop());
        stream.value = null;
      }
    }

    Vue.onMounted(() => {
      window.addEventListener('keydown', onKeydown);
      focusBarcode();
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        loadDevices().then(() => startCamera(''));
      } else {
        cameraError.value = '当前环境不支持摄像头调用';
      }
    });

    Vue.onUnmounted(() => {
      window.removeEventListener('keydown', onKeydown);
      stopCamera();
    });

    return {
      stream, devices, deviceId, cameraError, resolution, shots,
      barcode, note, saving, barcodeCount, videoEl, barcodeEl, ready,
      startCamera, capture, removeShot, clearShots, saveAll, checkBarcodeCount, onBarcodeDone
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>衣物拍照</h2>
        <p>扫码后自动进入拍摄状态，可连续拍多张、全部保存后自动编号；快捷键：<b>空格 = 拍照</b>，<b>回车 = 保存</b></p>
      </div>

      <div class="capture-layout">
        <div class="card">
          <div class="card-title">
            📷 摄像头取景
            <span v-if="resolution" class="tag tag-green" style="margin-left:8px">分辨率 {{ resolution }}</span>
          </div>
          <div class="camera-box">
            <video v-if="stream" ref="videoEl" autoplay playsinline muted></video>
            <div v-else class="camera-tip" :class="{ error: !!cameraError }">
              {{ cameraError || '摄像头准备中…' }}
              <div v-if="cameraError">
                <button class="btn btn-primary" @click="startCamera(deviceId)">重试</button>
              </div>
            </div>
          </div>
          <div class="camera-bar">
            <select v-if="devices.length > 1" v-model="deviceId" @change="startCamera(deviceId)">
              <option v-for="(d, i) in devices" :key="d.deviceId || i" :value="d.deviceId">
                {{ d.label || ('摄像头 ' + (i + 1)) }}
              </option>
            </select>
            <button class="btn btn-primary" :disabled="!stream" @click="capture">📸 拍照（空格）</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">🧾 存档信息</div>

          <label>衣物条形码 *</label>
          <input v-model="barcode" ref="barcodeEl" placeholder="扫码枪扫入或手动输入条形码，回车确认" @keyup.enter="onBarcodeDone" @change="onBarcodeDone" />
          <div v-if="ready && stream" class="barcode-count ok">条码已就绪，按空格键拍摄、回车保存全部</div>
          <div v-if="barcodeCount" class="barcode-count">该条码已存档 {{ barcodeCount }} 张，本次保存将接着编号</div>

          <label>备注</label>
          <textarea v-model="note" rows="2" placeholder="已有瑕疵、特殊洗护要求等（可选）"></textarea>

          <label>已拍照片（{{ shots.length }} 张）</label>
          <div v-if="shots.length" class="shot-queue">
            <div v-for="(s, i) in shots" :key="i" class="shot-thumb">
              <img :src="s" />
              <span class="shot-no">第 {{ i + 1 }} 张</span>
              <button class="shot-remove" title="移除" @click="removeShot(i)">✕</button>
            </div>
          </div>
          <div v-else class="capture-placeholder">按空格键连续拍摄，照片缩略图会出现在这里</div>

          <div style="display:flex;gap:10px;margin-top:16px">
            <button v-if="shots.length" class="btn btn-ghost" :disabled="saving" @click="clearShots">清空</button>
            <button class="btn btn-primary" style="flex:1" :disabled="saving" @click="saveAll">
              {{ saving ? '保存中…' : '保存全部（回车，共 ' + shots.length + ' 张）' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `
};

/* ---------- 客户端查询 / 管理端数据查看（共用） ---------- */
const QueryPage = {
  props: {
    token: { type: String, required: true },
    adminMode: { type: Boolean, default: false }
  },
  setup(props) {
    const keyword = Vue.ref('');
    const barcodeFilter = Vue.ref('');
    const dateFrom = Vue.ref('');
    const dateTo = Vue.ref('');
    const userIdFilter = Vue.ref('all');
    const users = Vue.ref([]);
    const items = Vue.ref([]);
    const total = Vue.ref(0);
    const page = Vue.ref(1);
    const pageSize = 12;
    const loading = Vue.ref(false);
    const detail = Vue.ref(null);
    const selected = Vue.ref([]); // 已勾选的记录 id
    const batchDeleting = Vue.ref(false);

    function toggleSelect(r) {
      const i = selected.value.indexOf(r.id);
      if (i === -1) selected.value.push(r.id);
      else selected.value.splice(i, 1);
    }

    function selectAll() {
      if (selected.value.length === items.value.length) {
        selected.value = [];
      } else {
        selected.value = items.value.map((r) => r.id);
      }
    }

    async function batchDelete() {
      if (!selected.value.length) {
        toast('请先勾选要删除的记录', 'error');
        return;
      }
      if (!window.confirm('确定批量删除选中的 ' + selected.value.length + ' 条记录？照片将一并删除，不可恢复。')) return;
      batchDeleting.value = true;
      try {
        const res = await window.api.deleteRecords(props.token, selected.value.slice());
        if (res.ok) {
          toast('已删除 ' + res.data.deleted + ' 条' + (res.data.skipped ? '，跳过无权限 ' + res.data.skipped + ' 条' : ''), 'success');
          selected.value = [];
          search(false);
        } else {
          toast(res.message || '批量删除失败', 'error');
        }
      } catch (e) {
        toast('批量删除失败：' + (e.message || e), 'error');
      } finally {
        batchDeleting.value = false;
      }
    }

    async function loadUsers() {
      if (!props.adminMode) return;
      const r = await window.api.listUsers(props.token);
      if (r.ok) users.value = r.data;
    }

    async function search(reset) {
      if (reset) page.value = 1;
      loading.value = true;
      try {
        const r = await window.api.listRecords(props.token, {
          keyword: keyword.value,
          barcode: barcodeFilter.value,
          dateFrom: dateFrom.value,
          dateTo: dateTo.value,
          userId: userIdFilter.value,
          page: page.value,
          pageSize
        });
        if (r.ok) {
          items.value = r.data.items;
          total.value = r.data.total;
          selected.value = [];
        } else {
          toast(r.message || '查询失败', 'error');
        }
      } catch (e) {
        toast('查询失败：' + (e.message || e), 'error');
      } finally {
        loading.value = false;
      }
    }

    function reset() {
      keyword.value = '';
      barcodeFilter.value = '';
      dateFrom.value = '';
      dateTo.value = '';
      userIdFilter.value = 'all';
      search(true);
    }

    async function openDetail(r) {
      const res = await window.api.getRecord(props.token, r.id);
      if (res.ok) detail.value = res.data;
      else toast(res.message || '打开失败', 'error');
    }

    async function remove(r) {
      if (!window.confirm('确定删除该存档记录？照片将一并删除，不可恢复。')) return;
      const res = await window.api.deleteRecord(props.token, r.id);
      if (res.ok) {
        toast('已删除', 'success');
        if (detail.value && detail.value.id === r.id) detail.value = null;
        search(false);
      } else {
        toast(res.message || '删除失败', 'error');
      }
    }

    const totalPages = Vue.computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

    function prev() {
      if (page.value > 1) {
        page.value--;
        search(false);
      }
    }

    function next() {
      if (page.value < totalPages.value) {
        page.value++;
        search(false);
      }
    }

    Vue.onMounted(() => {
      loadUsers();
      search(true);
    });

    return {
      keyword, barcodeFilter, dateFrom, dateTo, userIdFilter, users, items, total,
      page, pageSize, totalPages, loading, detail,
      selected, batchDeleting, toggleSelect, selectAll, batchDelete,
      search, reset, openDetail, remove, prev, next, fmt,
      adminMode: props.adminMode
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>{{ adminMode ? '数据查看' : '记录查询' }}</h2>
        <p>{{ adminMode ? '查看系统中所有账号登记的衣物存档数据' : '按条形码、备注、日期查找您存档的照片' }}</p>
      </div>

      <div class="card">
        <div class="filter-bar">
          <div class="f-item f-keyword">
            <label>条形码</label>
            <input v-model="barcodeFilter" placeholder="精确匹配条形码" @keyup.enter="search(true)" />
          </div>
          <div class="f-item f-keyword">
            <label>关键词</label>
            <input v-model="keyword" placeholder="条码 / 备注模糊搜索" @keyup.enter="search(true)" />
          </div>
          <div class="f-item f-date">
            <label>开始日期</label>
            <input type="date" v-model="dateFrom" />
          </div>
          <div class="f-item f-date">
            <label>结束日期</label>
            <input type="date" v-model="dateTo" />
          </div>
          <div v-if="adminMode" class="f-item f-user">
            <label>所属账号</label>
            <select v-model="userIdFilter">
              <option value="all">全部账号</option>
              <option v-for="u in users" :key="u.id" :value="u.id">{{ u.username }}（{{ u.name }}）</option>
            </select>
          </div>
          <button class="btn btn-primary" @click="search(true)">查询</button>
          <button class="btn btn-ghost" @click="reset">重置</button>
        </div>

        <div class="batch-bar" v-if="items.length">
          <label class="batch-check"><input type="checkbox" :checked="selected.length === items.length && items.length > 0" @change="selectAll" />全选本页</label>
          <span class="pager-info">已选 {{ selected.length }} 条</span>
          <button class="btn btn-danger btn-sm" :disabled="!selected.length || batchDeleting" @click="batchDelete">
            {{ batchDeleting ? '删除中…' : '批量删除' }}
          </button>
        </div>

        <div v-if="loading" class="empty">加载中…</div>
        <div v-else-if="!items.length" class="empty">暂无符合条件的存档记录</div>
        <div v-else class="record-grid">
          <div v-for="r in items" :key="r.id" class="record-card" @click="openDetail(r)">
            <div class="record-photo"><img :src="r.photoUrl" /></div>
            <div class="record-meta">
              <div class="record-customer">{{ r.barcode }}</div>
              <div class="record-tags">
                <span class="tag tag-orange">第 {{ r.seq }} 张</span>
                <span v-if="adminMode" class="tag tag-owner">{{ r.username }}</span>
              </div>
              <div class="record-time">{{ fmt(r.createdAt) }}</div>
            </div>
            <label class="card-check" :class="{ on: selected.includes(r.id) }" @click.stop>
              <input type="checkbox" :checked="selected.includes(r.id)" @change="toggleSelect(r)" />
            </label>
          </div>
        </div>

        <div class="pager">
          <span class="pager-info">共 {{ total }} 条 · 第 {{ page }}/{{ totalPages }} 页</span>
          <button class="btn btn-ghost btn-sm" :disabled="page <= 1" @click="prev">上一页</button>
          <button class="btn btn-ghost btn-sm" :disabled="page >= totalPages" @click="next">下一页</button>
        </div>
      </div>

      <div v-if="detail" class="modal-mask" @click.self="detail = null">
        <div class="modal">
          <div class="modal-head"><h3>存档详情</h3><button class="modal-close" @click="detail = null">✕</button></div>
          <div class="modal-body">
            <img class="modal-photo" :src="detail.photoUrl" />
            <div class="info-row"><span>条形码</span><b>{{ detail.barcode }}</b></div>
            <div class="info-row"><span>照片编号</span><b>第 {{ detail.seq }} 张</b></div>
            <div class="info-row"><span>备注</span><b>{{ detail.note || '无' }}</b></div>
            <div v-if="adminMode" class="info-row"><span>所属账号</span><b>{{ detail.username }}</b></div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-danger" @click="remove(detail)">删除记录</button>
            <button class="btn btn-ghost" @click="detail = null">关闭</button>
          </div>
        </div>
      </div>
    </div>
  `
};

/* ---------- 客户端 · 设置页 ---------- */
const SettingsPage = {
  props: { user: { type: Object, required: true }, token: { type: String, required: true } },
  setup(props) {
    const oldPassword = Vue.ref('');
    const newPassword = Vue.ref('');
    const confirmPassword = Vue.ref('');
    const saving = Vue.ref(false);

    async function submit() {
      if (!oldPassword.value || !newPassword.value) {
        toast('请填写完整的密码信息', 'error');
        return;
      }
      if (newPassword.value !== confirmPassword.value) {
        toast('两次输入的新密码不一致', 'error');
        return;
      }
      saving.value = true;
      try {
        const r = await window.api.changePassword(props.token, oldPassword.value, newPassword.value);
        if (r.ok) {
          toast('密码修改成功', 'success');
          oldPassword.value = '';
          newPassword.value = '';
          confirmPassword.value = '';
        } else {
          toast(r.message || '修改失败', 'error');
        }
      } catch (e) {
        toast('修改失败：' + (e.message || e), 'error');
      } finally {
        saving.value = false;
      }
    }

    return { user: props.user, oldPassword, newPassword, confirmPassword, saving, submit, fmt };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>设置</h2>
        <p>查看账号信息并修改登录密码</p>
      </div>

      <div class="settings-grid">
        <div class="card">
          <div class="card-title">👤 账号信息</div>
          <div class="info-row"><span>账号</span><b>{{ user.username }}</b></div>
          <div class="info-row"><span>姓名</span><b>{{ user.name }}</b></div>
          <div class="info-row"><span>角色</span><b>{{ user.role === 'admin' ? '管理员' : '客户端账号' }}</b></div>
          <div class="info-row"><span>拍照权限</span><b>{{ user.permissions && user.permissions.capture ? '已开通' : '未开通' }}</b></div>
          <div class="info-row"><span>查询权限</span><b>{{ user.permissions && user.permissions.query ? '已开通' : '未开通' }}</b></div>
          <div class="info-row"><span>创建时间</span><b>{{ fmt(user.createdAt) }}</b></div>
          <div class="info-row"><span>最近登录</span><b>{{ user.lastLoginAt ? fmt(user.lastLoginAt) : '-' }}</b></div>
        </div>

        <div class="card">
          <div class="card-title">🔒 修改密码</div>
          <label>原密码</label>
          <input v-model="oldPassword" type="password" placeholder="请输入原密码" />
          <label>新密码（至少 6 位）</label>
          <input v-model="newPassword" type="password" placeholder="请输入新密码" />
          <label>确认新密码</label>
          <input v-model="confirmPassword" type="password" placeholder="请再次输入新密码" />
          <button class="btn btn-primary" :disabled="saving" @click="submit">
            {{ saving ? '保存中…' : '保存修改' }}
          </button>
        </div>
      </div>
    </div>
  `
};

/* ---------- 管理端 · 数据总览 ---------- */
const AdminOverviewPage = {
  props: { token: { type: String, required: true } },
  setup(props) {
    const o = Vue.ref(null);

    async function load() {
      const r = await window.api.overview(props.token);
      if (r.ok) o.value = r.data;
      else toast(r.message || '加载失败', 'error');
    }

    Vue.onMounted(load);
    return { o, fmt };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>数据总览</h2>
        <p>账号、存档与操作日志的整体情况</p>
      </div>

      <div v-if="o" class="overview-grid">
        <div class="stat-card"><div class="lbl">账号总数</div><div class="num">{{ o.userCount }}</div></div>
        <div class="stat-card"><div class="lbl">启用中账号</div><div class="num">{{ o.activeUserCount }}</div></div>
        <div class="stat-card"><div class="lbl">存档照片总数</div><div class="num">{{ o.recordCount }}</div></div>
        <div class="stat-card"><div class="lbl">今日新增存档</div><div class="num">{{ o.todayRecordCount }}</div></div>
      </div>

      <h3 class="section-title">最近存档</h3>
      <div class="card">
        <div v-if="o && !o.recentRecords.length" class="empty">暂无存档记录</div>
        <div v-else-if="o" class="record-grid">
          <div v-for="r in o.recentRecords" :key="r.id" class="record-card" style="cursor:default">
            <div class="record-photo"><img :src="r.photoUrl" /></div>
            <div class="record-meta">
              <div class="record-customer">{{ r.barcode }}</div>
              <div class="record-tags">
                <span class="tag tag-orange">第 {{ r.seq }} 张</span>
                <span class="tag tag-owner">{{ r.username }}</span>
              </div>
              <div class="record-time">{{ fmt(r.createdAt) }}</div>
            </div>
          </div>
        </div>
      </div>

      <h3 class="section-title">最近操作日志</h3>
      <div class="card table-wrap">
        <table v-if="o">
          <thead>
            <tr><th>时间</th><th>账号</th><th>模块</th><th>操作</th><th class="wrap">详情</th></tr>
          </thead>
          <tbody>
            <tr v-for="l in o.recentLogs" :key="l.id">
              <td>{{ fmt(l.time) }}</td>
              <td>{{ l.username }}</td>
              <td>{{ l.module }}</td>
              <td><span class="tag" :class="l.result === '失败' ? 'tag-red' : 'tag-green'">{{ l.action }}</span></td>
              <td class="wrap">{{ l.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `
};

/* ---------- 管理端 · 用户与权限 ---------- */
const AdminUsersPage = {
  props: { token: { type: String, required: true } },
  setup(props) {
    const users = Vue.ref([]);
    const modal = Vue.ref(null); // 'create' | 'edit'
    const form = Vue.ref(emptyForm());
    const saving = Vue.ref(false);

    function emptyForm() {
      return {
        id: '', username: '', name: '', role: 'client',
        password: '', newPassword: '', active: true,
        permissions: { capture: true, query: true }
      };
    }

    async function load() {
      const r = await window.api.listUsers(props.token);
      if (r.ok) users.value = r.data;
      else toast(r.message || '加载失败', 'error');
    }

    function openCreate() {
      form.value = emptyForm();
      modal.value = 'create';
    }

    function openEdit(u) {
      form.value = {
        id: u.id,
        username: u.username,
        name: u.name,
        role: u.role,
        password: '',
        newPassword: '',
        active: u.active,
        permissions: { capture: !!u.permissions.capture, query: !!u.permissions.query }
      };
      modal.value = 'edit';
    }

    async function submit() {
      const f = form.value;
      saving.value = true;
      try {
        let r;
        if (modal.value === 'create') {
          r = await window.api.createUser(
            props.token,
            f.username,
            f.name,
            f.role,
            f.password,
            f.permissions.capture,
            f.permissions.query
          );
        } else {
          r = await window.api.updateUser(
            props.token,
            f.id,
            f.name,
            f.role,
            f.active,
            f.permissions.capture,
            f.permissions.query,
            f.newPassword
          );
        }
        if (r.ok) {
          toast(modal.value === 'create' ? '账号已创建' : '已保存修改', 'success');
          modal.value = null;
          load();
        } else {
          toast(r.message || '操作失败', 'error');
        }
      } catch (e) {
        toast('操作失败：' + (e.message || e), 'error');
      } finally {
        saving.value = false;
      }
    }

    async function toggleActive(u) {
      try {
        const r = await window.api.updateUser(props.token, u.id, u.name, u.role, !u.active, null, null, '');
        if (r.ok) {
          toast(u.active ? '账号已停用' : '账号已启用', 'success');
          load();
        } else {
          toast(r.message || '操作失败', 'error');
        }
      } catch (e) {
        toast('操作失败：' + (e.message || e), 'error');
      }
    }

    async function remove(u) {
      if (!window.confirm('确定删除账号 ' + u.username + '？该操作不可恢复。')) return;
      const r = await window.api.deleteUser(props.token, u.id);
      if (r.ok) {
        toast('账号已删除', 'success');
        load();
      } else {
        toast(r.message || '删除失败', 'error');
      }
    }

    Vue.onMounted(load);
    return { users, modal, form, saving, openCreate, openEdit, submit, toggleActive, remove, fmt };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>用户与权限管理</h2>
        <p>创建、编辑、停用或删除系统账号，并为每个账号分配功能权限</p>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <div class="card-title" style="margin:0;border:none;padding:0">账号列表（{{ users.length }}）</div>
          <button class="btn btn-primary" @click="openCreate">＋ 新增账号</button>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>用户名</th><th>姓名</th><th>角色</th><th>功能权限</th>
                <th>状态</th><th>创建时间</th><th>最近登录</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in users" :key="u.id">
                <td><b>{{ u.username }}</b></td>
                <td>{{ u.name }}</td>
                <td><span class="tag" :class="u.role === 'admin' ? 'tag-orange' : 'tag-gray'">{{ u.role === 'admin' ? '管理员' : '客户端' }}</span></td>
                <td>
                  <span v-if="u.role === 'admin'" class="tag tag-gray">全部功能</span>
                  <template v-else>
                    <span class="tag" :class="u.permissions.capture ? 'tag-green' : 'tag-gray'">拍照 {{ u.permissions.capture ? '开' : '关' }}</span>
                    <span class="tag" :class="u.permissions.query ? 'tag-green' : 'tag-gray'" style="margin-left:4px">查询 {{ u.permissions.query ? '开' : '关' }}</span>
                  </template>
                </td>
                <td><span class="tag" :class="u.active ? 'tag-green' : 'tag-red'">{{ u.active ? '启用' : '停用' }}</span></td>
                <td>{{ fmt(u.createdAt) }}</td>
                <td>{{ u.lastLoginAt ? fmt(u.lastLoginAt) : '-' }}</td>
                <td>
                  <div class="td-actions">
                    <button class="btn btn-ghost btn-sm" @click="openEdit(u)">编辑</button>
                    <button class="btn btn-ghost btn-sm" @click="toggleActive(u)">{{ u.active ? '停用' : '启用' }}</button>
                    <button class="btn btn-danger btn-sm" @click="remove(u)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="modal" class="modal-mask" @click.self="modal = null">
        <div class="modal modal-sm">
          <div class="modal-head">
            <h3>{{ modal === 'create' ? '新增账号' : '编辑账号' }}</h3>
            <button class="modal-close" @click="modal = null">✕</button>
          </div>
          <div class="modal-body">
            <label>用户名</label>
            <input v-model="form.username" :disabled="modal === 'edit'" placeholder="3-20 位字母、数字或下划线" />
            <label>姓名</label>
            <input v-model="form.name" placeholder="用于界面显示" />
            <label>角色</label>
            <select v-model="form.role">
              <option value="client">客户端（店员）</option>
              <option value="admin">管理员</option>
            </select>
            <template v-if="modal === 'create'">
              <label>初始密码（至少 6 位）</label>
              <input v-model="form.password" type="password" placeholder="请设置初始密码" />
            </template>
            <template v-else>
              <label>重置密码（留空表示不修改）</label>
              <input v-model="form.newPassword" type="password" placeholder="如需重置请输入新密码" />
              <div class="check-row" style="margin-top:14px">
                <label><input type="checkbox" v-model="form.active" />账号启用</label>
              </div>
            </template>
            <label>功能权限（客户端账号生效）</label>
            <div class="check-row">
              <label><input type="checkbox" v-model="form.permissions.capture" />衣物拍照</label>
              <label><input type="checkbox" v-model="form.permissions.query" />记录查询</label>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="modal = null">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="submit">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `
};

/* ---------- 管理端 · 操作日志 ---------- */
const AdminLogsPage = {
  props: { token: { type: String, required: true } },
  setup(props) {
    const keyword = Vue.ref('');
    const action = Vue.ref('all');
    const userIdFilter = Vue.ref('all');
    const dateFrom = Vue.ref('');
    const dateTo = Vue.ref('');
    const users = Vue.ref([]);
    const items = Vue.ref([]);
    const total = Vue.ref(0);
    const page = Vue.ref(1);
    const pageSize = 20;
    const loading = Vue.ref(false);
    const actions = [
      '登录', '登录失败', '退出登录', '修改密码',
      '新增存档', '删除存档', '查询记录', '查看记录',
      '新增用户', '修改用户', '重置密码', '删除用户',
      '查询日志', '修改端口', '重置连接码', '修改照片路径', '初始化'
    ];

    async function loadUsers() {
      const r = await window.api.listUsers(props.token);
      if (r.ok) users.value = r.data;
    }

    async function search(reset) {
      if (reset) page.value = 1;
      loading.value = true;
      try {
        const r = await window.api.listLogs(props.token, {
          keyword: keyword.value,
          action: action.value,
          userId: userIdFilter.value,
          dateFrom: dateFrom.value,
          dateTo: dateTo.value,
          page: page.value,
          pageSize
        });
        if (r.ok) {
          items.value = r.data.items;
          total.value = r.data.total;
        } else {
          toast(r.message || '查询失败', 'error');
        }
      } catch (e) {
        toast('查询失败：' + (e.message || e), 'error');
      } finally {
        loading.value = false;
      }
    }

    function reset() {
      keyword.value = '';
      action.value = 'all';
      userIdFilter.value = 'all';
      dateFrom.value = '';
      dateTo.value = '';
      search(true);
    }

    const totalPages = Vue.computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

    function prev() {
      if (page.value > 1) {
        page.value--;
        search(false);
      }
    }

    function next() {
      if (page.value < totalPages.value) {
        page.value++;
        search(false);
      }
    }

    Vue.onMounted(() => {
      loadUsers();
      search(true);
    });

    return {
      keyword, action, userIdFilter, dateFrom, dateTo, users, items, total,
      page, pageSize, totalPages, loading, actions,
      search, reset, prev, next, fmt
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>操作日志查询</h2>
        <p>查询所有账号的登录与操作记录，支持按账号、操作类型、关键词和日期筛选</p>
      </div>

      <div class="card">
        <div class="filter-bar">
          <div class="f-item f-keyword">
            <label>关键词</label>
            <input v-model="keyword" placeholder="账号 / 模块 / 详情" @keyup.enter="search(true)" />
          </div>
          <div class="f-item f-user">
            <label>账号</label>
            <select v-model="userIdFilter">
              <option value="all">全部账号</option>
              <option v-for="u in users" :key="u.id" :value="u.id">{{ u.username }}（{{ u.name }}）</option>
            </select>
          </div>
          <div class="f-item f-select">
            <label>操作类型</label>
            <select v-model="action">
              <option value="all">全部操作</option>
              <option v-for="a in actions" :key="a" :value="a">{{ a }}</option>
            </select>
          </div>
          <div class="f-item f-date">
            <label>开始日期</label>
            <input type="date" v-model="dateFrom" />
          </div>
          <div class="f-item f-date">
            <label>结束日期</label>
            <input type="date" v-model="dateTo" />
          </div>
          <button class="btn btn-primary" @click="search(true)">查询</button>
          <button class="btn btn-ghost" @click="reset">重置</button>
        </div>

        <div v-if="loading" class="empty">加载中…</div>
        <div v-else-if="!items.length" class="empty">暂无符合条件的日志</div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th><th>账号</th><th>角色</th><th>模块</th>
                <th>操作</th><th>结果</th><th class="wrap">详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in items" :key="l.id">
                <td>{{ fmt(l.time) }}</td>
                <td><b>{{ l.username }}</b></td>
                <td>{{ l.role === 'admin' ? '管理员' : (l.role === 'client' ? '客户端' : l.role) }}</td>
                <td>{{ l.module }}</td>
                <td>{{ l.action }}</td>
                <td><span class="tag" :class="l.result === '失败' ? 'tag-red' : 'tag-green'">{{ l.result }}</span></td>
                <td class="wrap">{{ l.detail }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="pager">
          <span class="pager-info">共 {{ total }} 条 · 第 {{ page }}/{{ totalPages }} 页</span>
          <button class="btn btn-ghost btn-sm" :disabled="page <= 1" @click="prev">上一页</button>
          <button class="btn btn-ghost btn-sm" :disabled="page >= totalPages" @click="next">下一页</button>
        </div>
      </div>
    </div>
  `
};

/* ---------- 管理端 · 系统设置 ---------- */
const AdminSystemPage = {
  props: { token: { type: String, required: true } },
  setup(props) {
    const info = Vue.ref(null);
    const localIp = Vue.ref('');
    const portInput = Vue.ref('');
    const savingPort = Vue.ref(false);
    const photoPathInput = Vue.ref('');
    const savingPath = Vue.ref(false);
    const resettingToken = Vue.ref(false);
    const version = Vue.ref('');
    const updateInfo = Vue.ref(null);
    const checking = Vue.ref(false);

    async function loadVersion() {
      const r = await window.api.version();
      if (r.ok) version.value = r.data.version;
    }

    async function checkUpdate(manual) {
      checking.value = true;
      try {
        const r = await window.api.checkUpdate();
        if (r.ok) {
          updateInfo.value = r.data;
          if (manual) {
            toast(
              r.data.hasUpdate
                ? '发现新版本 ' + r.data.latestVersion + '（当前 ' + r.data.currentVersion + '）'
                : '当前已是最新版本 ' + r.data.currentVersion,
              r.data.hasUpdate ? 'success' : 'success'
            );
          }
        } else if (manual) {
          toast(r.message || '检查更新失败', 'error');
        }
      } catch (e) {
        if (manual) toast('检查更新失败：' + (e.message || e), 'error');
      } finally {
        checking.value = false;
      }
    }

    async function openUpdateFolder() {
      const r = await window.api.openUpdateDir();
      if (!r.ok) toast(r.message || '打开失败', 'error');
    }

    async function openUpdatePage() {
      const r = await window.api.openUpdatePage();
      if (!r.ok) toast(r.message || '打开失败', 'error');
    }

    // 防火墙排查助手：复制放行命令，管理员在「管理员终端」中粘贴执行即可放行端口
    async function copyFirewallCmd() {
      const cmd =
        'netsh advfirewall firewall add rule name="星期衣衣物照片系统" dir=in action=allow protocol=TCP localport=' +
        (portInput.value || '17521');
      const r = await window.api.copyText(cmd);
      if (r.ok) toast('放行命令已复制：请右键「开始」菜单→「终端（管理员）」，粘贴并回车执行', 'success');
      else toast(r.message || '复制失败', 'error');
    }

    async function load() {
      const r = await window.api.systemInfo();
      if (r.ok) {
        info.value = r.data;
        portInput.value = String(r.data.port);
        photoPathInput.value = r.data.photoDir;
      }
      const ip = await window.api.localIp();
      if (ip.ok) localIp.value = ip.data;
      loadVersion();
      checkUpdate(false);
    }

    async function savePort() {
      savingPort.value = true;
      try {
        const r = await window.api.updateSettings(props.token, Number(portInput.value));
        if (r.ok) {
          toast('端口已保存，服务已按新端口重启', 'success');
          await load();
        } else {
          toast(r.message || '保存失败', 'error');
        }
      } catch (e) {
        toast('保存失败：' + (e.message || e), 'error');
      } finally {
        savingPort.value = false;
      }
    }

    async function resetToken() {
      if (!window.confirm('重置后，所有客户端需使用新连接码重新配置。确定重置？')) return;
      resettingToken.value = true;
      try {
        const r = await window.api.resetApiToken(props.token);
        if (r.ok) {
          toast('连接码已重置', 'success');
          await load();
        } else {
          toast(r.message || '重置失败', 'error');
        }
      } finally {
        resettingToken.value = false;
      }
    }

    async function chooseDir() {
      const r = await window.api.choosePhotoDir();
      if (r.ok) photoPathInput.value = r.data;
    }

    async function savePath() {
      savingPath.value = true;
      try {
        const r = await window.api.setPhotoPath(props.token, photoPathInput.value);
        if (r.ok) {
          toast('照片保存路径已更新，迁移照片 ' + r.data.moved + ' 张', 'success');
          await load();
        } else {
          toast(r.message || '保存失败', 'error');
        }
      } catch (e) {
        toast('保存失败：' + (e.message || e), 'error');
      } finally {
        savingPath.value = false;
      }
    }

    Vue.onMounted(load);
    return {
      info, localIp, portInput, savingPort, savePort,
      resettingToken, resetToken,
      photoPathInput, savingPath, chooseDir, savePath,
      version, updateInfo, checking, checkUpdate, openUpdateFolder, openUpdatePage, copyFirewallCmd
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>系统设置</h2>
        <p>服务端口、连接码与照片保存路径（仅服务端生效）</p>
      </div>

      <div v-if="info" class="settings-grid">
        <div class="card">
          <div class="card-title">🌐 服务信息</div>
          <div class="info-row"><span>运行模式</span><b>{{ info.mode === 'server' ? '服务端' : '客户端' }}</b></div>
          <div class="info-row"><span>本机局域网 IP</span><b>{{ localIp }}</b></div>
          <div class="info-row"><span>连接码</span><b class="code">{{ info.token }}</b></div>
          <div v-if="info.mode === 'client'" class="info-row"><span>服务器地址</span><b>{{ info.serverUrl }}</b></div>

          <div v-if="info.mode === 'server'">
            <label>服务端口（修改后自动重启服务）</label>
            <input v-model="portInput" type="number" min="1" max="65535" />
            <div style="display:flex;gap:10px;margin-top:16px">
              <button class="btn btn-primary" :disabled="savingPort" @click="savePort">
                {{ savingPort ? '保存中…' : '保存端口' }}
              </button>
              <button class="btn btn-ghost" :disabled="resettingToken" @click="resetToken">重置连接码</button>
            </div>
            <p class="setup-desc" style="margin-top:14px">
              其他电脑在本软件启动设置中选择「作为客户端」，
              填入地址 http://{{ localIp }}:{{ info.port }} 与上方连接码即可接入。
              跨城市使用时请通过异地组网或内网穿透工具打通网络。
            </p>
            <p class="setup-desc" style="margin-top:10px;padding:10px 12px;background:#fef9ec;border:1px solid #f5e0b0;border-radius:8px">
              💡 若局域网内其他电脑连不上：多为服务端电脑的防火墙拦截了入站连接。
              点击下方按钮复制放行命令，在「终端（管理员）」中粘贴执行后重试。
            </p>
            <div style="display:flex;gap:10px;margin-top:10px">
              <button class="btn btn-ghost" @click="copyFirewallCmd">复制防火墙放行命令</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">🖼️ 照片保存路径</div>
          <label>保存目录（修改时自动迁移现有照片）</label>
          <input v-model="photoPathInput" placeholder="选择或输入目录路径" />
          <div style="display:flex;gap:10px;margin-top:16px">
            <button class="btn btn-ghost" @click="chooseDir">浏览…</button>
            <button class="btn btn-primary" style="flex:1" :disabled="savingPath" @click="savePath">
              {{ savingPath ? '保存中…' : '保存路径' }}
            </button>
          </div>
          <p class="setup-desc" style="margin-top:14px">
            照片按原始分辨率保存为 JPG 文件；修改路径前会先校验目标目录，避免覆盖同名文件。
          </p>
        </div>
      </div>

      <div v-if="info" class="card" style="margin-top:18px">
        <div class="card-title">📦 版本与更新</div>
        <div class="info-row"><span>当前版本</span><b class="code">v{{ version || '-' }}</b></div>
        <div class="info-row">
          <span>检查结果</span>
          <b v-if="checking">检查中…</b>
          <b v-else-if="updateInfo && updateInfo.hasUpdate" style="color:#d97706">
            发现新版本 v{{ updateInfo.latestVersion }}
            <span v-if="updateInfo.source === 'local'">（来自服务端更新文件夹）</span>
          </b>
          <b v-else-if="updateInfo">已是最新版本</b>
          <b v-else>-</b>
        </div>
        <div class="info-row">
          <span>更新方式</span>
          <b>新版本通过 GitHub Releases 发布：启动或点击「检查更新」自动检测；发现新版本后点「前往下载」获取最新安装包，双击安装即可覆盖升级</b>
        </div>
        <div style="display:flex;gap:10px;margin-top:16px">
          <button class="btn btn-primary" :disabled="checking" @click="checkUpdate(true)">
            {{ checking ? '检查中…' : '检查更新' }}
          </button>
          <button class="btn btn-ghost" @click="openUpdatePage">前往下载页</button>
          <button v-if="info.mode === 'server'" class="btn btn-ghost" @click="openUpdateFolder">打开备用更新文件夹</button>
        </div>
      </div>
    </div>
  `
};

/* ---------- 主界面框架（侧边栏 + 页面切换） ---------- */
const Shell = {
  props: { user: { type: Object, required: true }, token: { type: String, required: true }, mode: { type: String, default: '' } },
  emits: ['logout'],
  setup(props, { emit }) {
    const isAdmin = props.user.role === 'admin';
    const version = Vue.ref('');

    window.api.version().then((r) => {
      if (r.ok) version.value = r.data.version;
    });

    const pages = isAdmin
      ? [
          { key: 'overview', icon: '📊', label: '数据总览' },
          { key: 'users', icon: '👥', label: '用户与权限' },
          { key: 'logs', icon: '📋', label: '操作日志' },
          { key: 'data', icon: '🗂️', label: '数据查看' },
          { key: 'system', icon: '🛠️', label: '系统设置' }
        ]
      : [
          { key: 'home', icon: '🏠', label: '首页' },
          { key: 'capture', icon: '📷', label: '衣物拍照' },
          { key: 'query', icon: '🔍', label: '记录查询' },
          { key: 'settings', icon: '⚙️', label: '设置' }
        ];

    const comps = isAdmin
      ? { overview: AdminOverviewPage, users: AdminUsersPage, logs: AdminLogsPage, data: QueryPage, system: AdminSystemPage }
      : { home: HomePage, capture: CapturePage, query: QueryPage, settings: SettingsPage };

    const active = Vue.ref(pages[0].key);

    async function doLogout() {
      const r = await window.api.logout(props.token);
      emit('logout');
      toast(r.ok ? '已退出登录' : r.message || '退出失败', r.ok ? 'success' : 'error');
    }

    return { user: props.user, mode: props.mode, isAdmin, pages, comps, active, doLogout, version };
  },
  template: `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-logo">👕</div>
          <div>
            <div class="brand-name">星期衣精致洗衣</div>
            <div class="brand-sub">衣物照片系统 · {{ isAdmin ? '管理端' : '客户端' }}</div>
          </div>
        </div>
        <nav class="nav">
          <div
            v-for="p in pages"
            :key="p.key"
            class="nav-item"
            :class="{ active: active === p.key }"
            @click="active = p.key"
          >
            <span class="nav-icon">{{ p.icon }}</span>{{ p.label }}
          </div>
        </nav>
        <div class="sidebar-foot">
          <div class="user-chip">
            <div class="avatar">{{ (user.name || user.username).charAt(0) }}</div>
            <div>
              <div class="user-name">{{ user.name || user.username }}</div>
              <div class="user-role">{{ isAdmin ? '管理员' : '店员账号' }} · {{ mode === 'client' ? '已连接服务器' : '本机服务端' }}</div>
            </div>
          </div>
          <button class="btn btn-ghost btn-block" @click="doLogout">退出登录</button>
          <div class="sidebar-version">版本 v{{ version || '-' }}</div>
        </div>
      </aside>
      <main class="main">
        <component
          :is="comps[active]"
          :user="user"
          :token="token"
          :admin-mode="isAdmin"
          @goto="active = $event"
        ></component>
      </main>
    </div>
  `
};

/* ---------- 根应用 ---------- */
const app = createApp({
  setup() {
    const sysInfo = Vue.ref(null);
    const user = Vue.ref(null);
    const token = Vue.ref('');
    const ready = Vue.ref(false);
    const needRestart = Vue.ref(false);
    const updateNotice = Vue.ref(null);

    window.api.systemInfo().then((r) => {
      if (r.ok) sysInfo.value = r.data;
      ready.value = true;
    });

    // 启动时检查更新：优先 GitHub Releases，无法访问时回退服务端更新文件夹
    window.api.checkUpdate().then((r) => {
      if (r.ok && r.data && r.data.hasUpdate) {
        updateNotice.value = r.data;
      }
    });

    function closeUpdateNotice() {
      updateNotice.value = null;
    }

    function gotoDownload() {
      window.api.openUpdatePage();
    }

    function onSetupDone() {
      needRestart.value = true;
    }

    function onServerSaved() {
      // 服务器设置保存成功后刷新系统信息（立即生效，无需重启）
      window.api.systemInfo().then((r) => {
        if (r.ok) sysInfo.value = r.data;
      });
    }

    function onLogin(data) {
      user.value = data.user;
      token.value = data.sessionToken;
    }

    function onLogout() {
      user.value = null;
      token.value = '';
    }

    return {
      sysInfo, user, token, ready, needRestart, updateNotice,
      onSetupDone, onServerSaved, onLogin, onLogout, closeUpdateNotice, gotoDownload
    };
  },
  template: `
    <div style="height:100%;display:flex;flex-direction:column">
      <div v-if="updateNotice" class="update-banner">
        <span>
          🔔 发现新版本 <b>v{{ updateNotice.latestVersion }}</b>（当前 v{{ updateNotice.currentVersion }}）
          <template v-if="updateNotice.source === 'github'">，已发布到 GitHub Releases。</template>
          <template v-else-if="updateNotice.latestFile">，安装包：{{ updateNotice.latestFile }}，请联系管理员获取。</template>
          <template v-else>，请联系管理员获取更新。</template>
        </span>
        <div style="display:flex;align-items:center;gap:8px">
          <button class="update-banner-close" style="color:#9a3412;font-weight:600" @click="gotoDownload">前往下载</button>
          <button class="update-banner-close" @click="closeUpdateNotice">✕</button>
        </div>
      </div>
      <div style="flex:1;min-height:0">
        <div v-if="!ready" style="height:100%;display:flex;align-items:center;justify-content:center;color:#64748b">
          正在启动…
        </div>
        <div v-else-if="needRestart" class="login-wrap">
          <div class="login-card">
            <div class="login-logo">✅</div>
            <h1>配置已保存</h1>
            <div class="login-sub">请关闭应用窗口后重新运行，即可按新模式启动</div>
          </div>
        </div>
        <setup-page v-else-if="sysInfo && !sysInfo.mode" @done="onSetupDone"></setup-page>
        <shell v-else-if="user" :user="user" :token="token" :mode="sysInfo ? sysInfo.mode : ''" @logout="onLogout"></shell>
        <login-page v-else :sys-info="sysInfo" @login="onLogin" @server-saved="onServerSaved"></login-page>
      </div>
    </div>
  `
});

app.component('login-page', LoginPage);
app.component('setup-page', SetupPage);
app.component('shell', Shell);
app.mount('#app');
