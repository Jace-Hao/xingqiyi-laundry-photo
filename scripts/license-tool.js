#!/usr/bin/env node
'use strict';

/**
 * 激活码计算工具（管理员专用，不随软件分发）
 *
 * 用法：
 *   node scripts/license-tool.js                 查看本机机器码与激活码
 *   node scripts/license-tool.js <机器码>         根据客户提供的机器码生成激活码
 *   node scripts/license-tool.js --verify <机器码> <激活码>   校验激活码是否有效
 *
 * 机器码在客户软件登录页的「软件激活」弹窗中显示，格式如 FP97-YDRP-YZ2Q-GABW。
 * 激活码与机器码一一绑定，每台电脑需单独生成。
 */

const { genMachineCode, genActivationCode, verifyActivationCode, TRIAL_DAYS } = require('../main/license');

const args = process.argv.slice(2);

function usage() {
  console.log('激活码计算工具');
  console.log('');
  console.log('用法：');
  console.log('  node scripts/license-tool.js                        查看本机机器码与激活码');
  console.log('  node scripts/license-tool.js <机器码>               根据机器码生成激活码');
  console.log('  node scripts/license-tool.js --verify <机器码> <激活码>  校验激活码');
  console.log('');
  console.log('机器码格式示例：FP97-YDRP-YZ2Q-GABW');
  console.log('试用期：' + TRIAL_DAYS + ' 天');
}

try {
  if (args.length === 0) {
    const mc = genMachineCode();
    console.log('本机机器码：' + mc);
    console.log('本机激活码：' + genActivationCode(mc));
    console.log('');
    console.log('提示：客户机器的机器码与本机不同，请让客户在软件登录页「软件激活」弹窗中复制其机器码。');
  } else if (args[0] === '--verify' || args[0] === '-v') {
    if (args.length < 3) {
      console.error('校验需要两个参数：<机器码> <激活码>');
      process.exit(1);
    }
    const ok = verifyActivationCode(args[1], args[2]);
    console.log(ok ? '✓ 激活码有效' : '✗ 激活码无效（与机器码不匹配）');
    process.exit(ok ? 0 : 2);
  } else if (args[0] === '--help' || args[0] === '-h') {
    usage();
  } else {
    const mc = args[0];
    const code = genActivationCode(mc);
    console.log('机器码：' + String(mc).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-'));
    console.log('激活码：' + code);
    console.log('');
    console.log('请把激活码发给客户，在软件登录页「软件激活」弹窗中输入即可激活。');
  }
} catch (e) {
  console.error('错误：' + (e.message || e));
  process.exit(1);
}
