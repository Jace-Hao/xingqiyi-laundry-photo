'use strict';

/**
 * 黑帧复采回归（对应「预览正常却间歇性提示全黑、无法拍摄」缺陷）
 *
 * 缺陷本质：拍照时对画面中心做**单次**灰度采样，命中即拒收。而部分 UVC 摄像头在
 * single-shot 对焦脉冲 / 自动曝光调整 / 分辨率重协商期间会短暂停输出，那一瞬画面
 * 确实是黑的，预览上看只是一闪 —— 单次采样把这种瞬时黑帧当成「镜头被遮挡」拒收。
 *
 * 修复后语义（camera-controller.js）：
 *   isBlackFrame(el)        同步单次采样 —— 对外契约**完全不变**（既有测试依赖同步布尔）
 *   confirmBlackFrame(el)   异步复采 —— 命中黑帧后在 blackRetryMs 预算内按间隔复采，
 *                           只有「持续全黑」才返回 true（拒拍）
 *
 * 关键取舍：只放宽「时间维度」，**不动阈值**（blackMean/blackVariance），
 * 因此不会削弱「真挡镜头 / 真黑照片入库」的拦截能力 —— 用例 B 组即为此把关。
 *
 * 用法：node scripts/verify-camera-blackretry.js
 */
const path = require('path');
const C = require(path.join(__dirname, '..', 'renderer', 'camera-controller.js'));

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + msg);
  } else {
    fail++;
    console.log('  ✗ ' + msg);
  }
}

// 可脚本化采样器：每次调用返回序列中的下一个值（undefined 则一直用最后一个）
function makeSampler(values) {
  let i = 0;
  return function () {
    const v = values[Math.min(i, values.length - 1)];
    i++;
    return v;
  };
}

const FLAT_BLACK = new Array(64 * 64).fill(0); // 全 0：均值 0、方差 0 → 判黑
const NORMAL = new Array(64 * 64).fill(80); // 均值 80 → 不判黑

const CFG = { blackRetryMs: 80, blackSampleGapMs: 25 }; // 缩短以便快速跑完

function makeController(sampler, extra) {
  const logs = [];
  const opt = Object.assign(
    {
      config: CFG,
      log: function (level, event, fields) {
        logs.push({ level: level, event: event, fields: fields || {} });
      },
      videoGetter: function () {
        return { readyState: 4, videoWidth: 1280, videoHeight: 720 };
      },
      frameSampler: sampler,
      blackFrameEnabled: function () {
        return true;
      }
    },
    extra || {}
  );
  const c = C.createCameraController(opt);
  c.mount(); // alive=true（无 mediaDevices 时会失败置 ERROR，不影响 confirmBlackFrame 判定）
  return { c: c, logs: logs };
}

function eventsOf(logs, name) {
  return logs.filter(function (l) {
    return l.event === name;
  });
}

(async function main() {
  console.log('黑帧复采回归（瞬时黑帧放行 / 持续黑帧拒收）');

  // ---------- A. 瞬时黑帧：首帧黑、随后恢复 → 必须放行 ----------
  console.log('\nA 组：瞬时黑帧（对焦脉冲 / 自动曝光的典型波形）');
  {
    let calls = 0;
    const sampler = function () {
      calls++;
      return calls === 1 ? FLAT_BLACK : NORMAL; // 只黑一帧
    };
    const { c, logs } = makeController(sampler);
    const r = await c.confirmBlackFrame({ readyState: 4, videoWidth: 1280, videoHeight: 720 });
    assert(r === false, '瞬时黑帧放行（不再误拒拍）');
    assert(calls >= 2, '确实发生了复采（采样次数 ' + calls + ' ≥ 2）');
    assert(eventsOf(logs, 'CAM_BLACK_RETRY').length === 1, '记录一次 CAM_BLACK_RETRY（瞬时恢复）');
    assert(
      eventsOf(logs, 'CAM_CAPTURE_REJECT').filter(function (l) {
        return l.fields.reason === 'black-frame-persistent';
      }).length === 0,
      '没有误记为「持续黑帧拒收」'
    );
    c.unmount();
  }

  // ---------- B. 持续黑帧：全程黑 → 必须拒收（真挡镜头不能放行） ----------
  console.log('\nB 组：持续黑帧（镜头真被遮挡）');
  {
    const { c, logs } = makeController(makeSampler([FLAT_BLACK]));
    const r = await c.confirmBlackFrame({ readyState: 4, videoWidth: 1280, videoHeight: 720 });
    assert(r === true, '持续黑帧仍然拒收（拦截能力未被削弱）');
    const rej = eventsOf(logs, 'CAM_CAPTURE_REJECT').filter(function (l) {
      return l.fields.reason === 'black-frame-persistent';
    });
    assert(rej.length === 1, '记录一次 black-frame-persistent 拒收');
    assert(rej.length && rej[0].fields.attempts >= 2, '拒收时带复采次数 attempts=' + (rej.length ? rej[0].fields.attempts : 'n/a'));
    c.unmount();
  }

  // ---------- C. 首帧正常：不该做无谓复采 ----------
  console.log('\nC 组：正常画面');
  {
    let calls = 0;
    const sampler = function () {
      calls++;
      return NORMAL;
    };
    const { c } = makeController(sampler);
    const r = await c.confirmBlackFrame({ readyState: 4, videoWidth: 1280, videoHeight: 720 });
    assert(r === false, '正常画面放行');
    assert(calls === 1, '首帧即正常时只采样 1 次（不拖慢拍照）');
    c.unmount();
  }

  // ---------- D. 检测关闭 / 采样失败：一律放行（不因检测缺失拦拍） ----------
  console.log('\nD 组：降级与容错');
  {
    const { c } = makeController(makeSampler([FLAT_BLACK]), {
      blackFrameEnabled: function () {
        return false;
      }
    });
    assert((await c.confirmBlackFrame({})) === false, 'window.__xqyBlackFrame=false 关闭检测后放行');
    c.unmount();
  }
  {
    const { c } = makeController(function () {
      throw new Error('sampler boom');
    });
    assert((await c.confirmBlackFrame({})) === false, '采样器抛异常时放行（不因检测失败拦拍）');
    c.unmount();
  }
  {
    const { c } = makeController(function () {
      return null;
    });
    assert((await c.confirmBlackFrame({})) === false, '采样返回空时放行');
    c.unmount();
  }

  // ---------- E. 复采期间被卸载 / 休眠：不拦拍 ----------
  console.log('\nE 组：复采期间生命周期切换');
  {
    const { c } = makeController(makeSampler([FLAT_BLACK]));
    const p = c.confirmBlackFrame({ readyState: 4, videoWidth: 1280, videoHeight: 720 });
    c.unmount(); // 复采途中卸载
    const r = await p;
    assert(r === false, '复采途中 unmount → 放行（交给上层状态闸门裁决，不卡住拍照）');
  }

  // ---------- F. 既有同步契约不被破坏（回归保护） ----------
  console.log('\nF 组：isBlackFrame 同步契约不变');
  {
    const { c } = makeController(makeSampler([FLAT_BLACK]));
    assert(c.isBlackFrame({}) === true, '同步 isBlackFrame 仍返回布尔 true（既有测试依赖）');
    c.unmount();
    const { c: c2 } = makeController(makeSampler([NORMAL]));
    assert(c2.isBlackFrame({}) === false, '同步 isBlackFrame 仍返回布尔 false');
    c2.unmount();
  }

  // ---------- G. 复采次数有界（受 blackRetryMs 预算约束） ----------
  console.log('\nG 组：总预算约束');
  {
    let calls = 0;
    const sampler = function () {
      calls++;
      return FLAT_BLACK;
    };
    const { c } = makeController(sampler);
    await c.confirmBlackFrame({});
    // 预算 80ms / 间隔 25ms → 首采 + 约 3~4 次复采，上界 = 预算/间隔 + 2
    const upper = Math.ceil(CFG.blackRetryMs / CFG.blackSampleGapMs) + 2;
    assert(calls <= upper, '复采次数有界：' + calls + ' ≤ ' + upper + '（不会无限采样拖慢拍照）');
    c.unmount();
  }

  // ---------- H. 负向对照：blackRetryMs=0 ≡ 退回「单次采样」语义 ----------
  // 不改源码即可复现旧行为：预算为 0 时复采循环一次都不进，等价于旧的单次采样。
  // 这一组必须「红」——它证明 A 组不是恒真的假阳性。
  console.log('\nH 组：负向对照（预算 0 ≡ 旧的单次采样行为）');
  {
    const logs = [];
    const c = C.createCameraController({
      config: { blackRetryMs: 0, blackSampleGapMs: 25 },
      log: function (level, event, fields) {
        logs.push({ level: level, event: event, fields: fields || {} });
      },
      videoGetter: function () {
        return { readyState: 4, videoWidth: 1280, videoHeight: 720 };
      },
      frameSampler: (function () {
        let i = 0;
        return function () {
          i++;
          return i === 1 ? FLAT_BLACK : NORMAL; // 同一个「只黑一帧」的波形
        };
      })(),
      blackFrameEnabled: function () {
        return true;
      }
    });
    c.mount();
    const r = await c.confirmBlackFrame({});
    assert(r === true, '负向对照：预算为 0（单次采样）时会误拒 —— 证明 A 组确实在防这个缺陷');
    c.unmount();
  }

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  console.log(
    '\n负向对照说明：A 组「瞬时黑帧放行」本身就是对「退回单次采样」的变异探针 —— ' +
      '若有人把 confirmBlackFrame 改回单次采样，A 组第 1、2 条会立刻变红（首帧黑即返回 true）。'
  );
  process.exit(fail ? 1 : 0);
})();
