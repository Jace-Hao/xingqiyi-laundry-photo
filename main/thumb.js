'use strict';
/**
 * 缩略图生成与缓存服务。
 *
 * 为什么需要它：查询页/首页/数据总览的网格缩略图显示区域只有约 180px 宽，
 * 但此前加载的是摄像头最大分辨率原图（可达 4000×3000、单张数 MB）。
 * 门店互查开启后单页照片数量成倍增加，一页要传输上百 MB 才能显示满屏小图。
 *
 * 设计取舍：
 * - 用 Electron 原生 nativeImage.resize()，不引入 sharp/jimp/canvas 等依赖，
 *   保持项目「零运行时依赖」的风格（离线安装、体积小、无需编译原生模块）。
 * - 缓存目录放在 userData/thumbs/，**不放进照片目录**：照片目录是用户数据，
 *   往里面写大量生成文件会污染备份范围，也可能被用户的同步盘反复上传。
 * - 缓存文件名 = hash(照片相对路径 + '_' + 宽度)，**不把 mtime 编进文件名**。
 *   这样同一张照片同一宽度只会有一个缓存文件（覆盖式更新），不会因为原图
 *   被替换而累积孤儿文件；有效性改用「缩略图 mtime 是否不早于原图 mtime」判断，
 *   原图一旦更新，缩略图自动失效并重新生成。
 * - 缓存文件先写临时文件再原子改名：协议处理器与 HTTP 服务可能并发为同一张
 *   照片生成缩略图，直接写目标文件会让并发读取方读到写了一半的半成品。
 * - 缩放失败时返回 null，由调用方回退到原图——宁可慢，也不让界面出现破图。
 *
 * 依赖注入：nativeImage 通过 createThumbService 的参数传入，默认才 require('electron')。
 * 这样纯 Node 环境（验证脚本）也能测试路径计算、有效性判断、参数校验等逻辑，
 * 只有真正的图像缩放必须在 Electron 运行时验证。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 缩略图边长上限：防止被传入超大尺寸导致生成「假缩略图」甚至内存压力 */
const MAX_THUMB_SIZE = 2048;

/**
 * 默认缩略图宽度。
 * 网格卡片显示区域约 180px 宽，取 2 倍以照顾高 DPI 屏幕（否则缩略图会发虚）。
 * 生成与清理必须使用同一个常量，否则清理会漏删或删错。
 */
const DEFAULT_THUMB_WIDTH = 360;

/**
 * 规范化缩略图宽度参数。
 * 只接受 16 ~ MAX_THUMB_SIZE 的正整数，其余一律返回 null（调用方应回退原图）。
 * 不做静默兜底：把非法值悄悄改成默认宽度，会让调用方的 bug 难以发现。
 * @param {*} v
 * @returns {number|null}
 */
function normalizeThumbSize(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n < 16 || n > MAX_THUMB_SIZE) return null;
  return n;
}

/**
 * 计算缩略图缓存文件的绝对路径。
 * 输入必须是数据层校验过的相对路径（resolvePhotoFile 已做路径穿越防护），
 * 这里再取 basename 兜底，确保 hash 输入不含目录穿越成分。
 * @param {string} relPath 照片相对路径
 * @param {number} size 缩略图宽度
 * @param {string} thumbsDir 缓存目录
 * @returns {string}
 */
function thumbFilePath(relPath, size, thumbsDir) {
  const h = crypto
    .createHash('sha1')
    .update(String(relPath) + '_' + size)
    .digest('hex')
    .slice(0, 24);
  return path.join(thumbsDir, h + '.jpg');
}

/**
 * 创建缩略图服务。
 * @param {object} opts
 * @param {string} opts.thumbsDir 缩略图缓存目录（userData/thumbs）
 * @param {object} [opts.nativeImage] Electron 的 nativeImage 模块；缺省时延迟 require
 * @returns {{thumbFilePath:Function, getOrCreate:Function, removeFor:Function, normalizeSize:Function}}
 */
function createThumbService({ thumbsDir, nativeImage } = {}) {
  if (!thumbsDir) throw new Error('thumbsDir 必填');

  /** 延迟获取 nativeImage，使本模块在纯 Node 下也能加载（便于测试） */
  function imageModule() {
    if (nativeImage) return nativeImage;
    // eslint-disable-next-line global-require
    const electron = require('electron');
    return electron.nativeImage;
  }

  function ensureDir() {
    fs.mkdirSync(thumbsDir, { recursive: true });
  }

  /**
   * 判断已有缓存是否仍然有效：缩略图存在，且其 mtime 不早于原图 mtime。
   * 原图被替换（mtime 变新）时缓存自动失效，不需要额外的版本记录。
   * @param {string} thumbPath
   * @param {string} srcPath
   * @returns {boolean}
   */
  function isFresh(thumbPath, srcPath) {
    try {
      const t = fs.statSync(thumbPath);
      if (!t.isFile() || t.size <= 0) return false;
      const s = fs.statSync(srcPath);
      return t.mtimeMs >= s.mtimeMs;
    } catch (e) {
      return false;
    }
  }

  /**
   * 原子写入：先写临时文件再改名，避免并发读取到写了一半的缓存。
   * 服务端模式下协议处理器（本机界面）与 HTTP 服务（远程客户端）可能并发
   * 为同一张照片生成缩略图；改名在同一目录内是原子操作。
   */
  function writeAtomic(target, writeTmp) {
    const tmp = target + '.' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try {
      writeTmp(tmp);
      fs.renameSync(tmp, target);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch (e2) {
        /* 临时文件清理失败不影响主流程 */
      }
      throw e;
    }
  }

  /**
   * 取得（必要时生成）缩略图，返回其绝对路径；失败返回 null 以便回退原图。
   * @param {string} srcPath 原图绝对路径
   * @param {string} relPath 原图相对路径（用于计算缓存键）
   * @param {number} size 目标宽度（须已通过 normalizeThumbSize 校验）
   * @returns {string|null}
   */
  function getOrCreate(srcPath, relPath, size) {
    const width = normalizeThumbSize(size);
    if (!width || !srcPath || !relPath) return null;

    const out = thumbFilePath(relPath, width, thumbsDir);
    if (isFresh(out, srcPath)) return out;

    try {
      const img = imageModule().createFromFile(srcPath);
      if (!img || img.isEmpty()) return null;
      // 缓存目录可能尚未创建（首次请求），复制与缩放两条路径都需要它
      ensureDir();
      // 原图本来就更小则不放大，避免无意义的插值劣化与体积增大
      const srcW = img.getSize().width;
      if (srcW <= width) {
        // 仍需落一份缓存，使后续请求走缓存路径；直接复制原文件即可
        writeAtomic(out, (tmp) => fs.copyFileSync(srcPath, tmp));
        return out;
      }
      const resized = img.resize({ width, quality: 'good' });
      if (!resized || resized.isEmpty()) return null;
      // 质量 78 在 360px 宽下肉眼几乎无差别，而体积约为原图的百分之一量级
      const buf = resized.toJPEG(78);
      if (!buf || !buf.length) return null;
      writeAtomic(out, (tmp) => fs.writeFileSync(tmp, buf));
      return out;
    } catch (e) {
      // 生成失败不回退为报错：调用方拿到 null 后会用原图，功能不受影响
      return null;
    }
  }

  /**
   * 删除某张照片对应的缩略图缓存（照片被删除或路径迁移时调用）。
   * 只删除能精确计算出的那些缓存文件，不遍历目录、不做模糊匹配删除。
   * @param {string} relPath 照片相对路径
   * @param {number[]} [sizes] 需清理的宽度列表；缺省只清理默认宽度
   * @returns {number} 实际删除的文件数
   */
  function removeFor(relPath, sizes) {
    if (!relPath) return 0;
    const list = Array.isArray(sizes) && sizes.length ? sizes : [DEFAULT_THUMB_WIDTH];
    let n = 0;
    for (const s of list) {
      const w = normalizeThumbSize(s);
      if (!w) continue;
      const p = thumbFilePath(relPath, w, thumbsDir);
      try {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          n++;
        }
      } catch (e) {
        /* 删不掉就留着，下次会覆盖；不因此中断删除照片的主流程 */
      }
    }
    return n;
  }

  return {
    thumbFilePath: (relPath, size) => thumbFilePath(relPath, size, thumbsDir),
    isFresh,
    getOrCreate,
    removeFor,
    normalizeSize: normalizeThumbSize,
    dir: thumbsDir
  };
}

module.exports = {
  createThumbService,
  normalizeThumbSize,
  thumbFilePath,
  MAX_THUMB_SIZE,
  DEFAULT_THUMB_WIDTH
};
