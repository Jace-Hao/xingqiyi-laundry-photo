'use strict';

/* 生成《星期衣精致洗衣衣物照片系统操作手册》Word 文档 */

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, LevelFormat, HeadingLevel, BorderStyle,
  WidthType, ShadingType, VerticalAlign, PageNumber, PageBreak
} = require('docx');

/* ---------- 设计令牌 ---------- */
const FONT = {
  heading: { ascii: 'Arial', eastAsia: '微软雅黑' },
  body: { ascii: 'Arial', eastAsia: '微软雅黑' }
};
const FS = {
  coverTitle: 52, coverSub: 28,
  h1: 32, h2: 28, h3: 26,
  body: 22, table: 20, caption: 18, footnote: 16
};
const SPACING = {
  lineBody: 340, paraAfter: 100,
  h1: { before: 360, after: 160 },
  h2: { before: 260, after: 120 },
  h3: { before: 200, after: 80 },
  firstLineIndent: 440
};
const NEUTRAL = {
  text: '1A1A1A', textSecondary: '4D4D4D', textMuted: '808080'
};
const THEME = {
  primary: '1F3A5F', accent: '3B6CA8',
  tableHeaderBg: '1F3A5F', tableHeaderText: 'FFFFFF',
  zebra: 'EEF3F8', border: 'D0D7DE', ...NEUTRAL
};

/* ---------- 段落辅助 ---------- */
function body(text, opts = {}) {
  return new Paragraph({
    alignment: AlignmentType.BOTH,
    spacing: { after: SPACING.paraAfter, line: SPACING.lineBody },
    indent: opts.noIndent ? undefined : { firstLine: SPACING.firstLineIndent },
    children: [new TextRun({ text: text, font: FONT.body, size: FS.body, color: NEUTRAL.text, bold: !!opts.bold })]
  });
}

function tip(text) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { after: SPACING.paraAfter, line: SPACING.lineBody },
    indent: { left: 360 },
    children: [
      new TextRun({ text: '提示：', font: FONT.body, size: FS.body, color: THEME.accent, bold: true }),
      new TextRun({ text: text, font: FONT.body, size: FS.body, color: NEUTRAL.textSecondary })
    ]
  });
}

function h1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, alignment: AlignmentType.LEFT, children: [new TextRun({ text: text })] });
}
function h2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, alignment: AlignmentType.LEFT, children: [new TextRun({ text: text })] });
}
function h3(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_3, alignment: AlignmentType.LEFT, children: [new TextRun({ text: text })] });
}

function bullet(text) {
  return new Paragraph({
    numbering: { reference: 'bullet-list', level: 0 },
    alignment: AlignmentType.LEFT,
    spacing: { after: 60, line: SPACING.lineBody },
    children: [new TextRun({ text: text, font: FONT.body, size: FS.body, color: NEUTRAL.text })]
  });
}

function steps(reference, text) {
  return new Paragraph({
    numbering: { reference: reference, level: 0 },
    alignment: AlignmentType.LEFT,
    spacing: { after: 60, line: SPACING.lineBody },
    children: [new TextRun({ text: text, font: FONT.body, size: FS.body, color: NEUTRAL.text })]
  });
}

/* ---------- 表格辅助 ---------- */
const tableBorder = { style: BorderStyle.SINGLE, size: 1, color: THEME.border };
const cellBorders = { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder };
const PAGE_WIDTH_DXA = 9360;

function makeTable(headers, rows, colAlign) {
  const colCount = headers.length;
  const colWidth = Math.floor(PAGE_WIDTH_DXA / colCount);
  const mkCell = (text, c, opts = {}) => new TableCell({
    borders: cellBorders,
    width: { size: colWidth, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    shading: opts.shading,
    children: [new Paragraph({
      alignment: colAlign[c],
      children: [new TextRun({
        text: String(text),
        font: FONT.body,
        size: FS.table,
        color: opts.headerCell ? THEME.tableHeaderText : NEUTRAL.text,
        bold: !!opts.headerCell || !!opts.bold
      })]
    })]
  });
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((hd, c) => mkCell(hd, c, {
      headerCell: true,
      shading: { fill: THEME.tableHeaderBg, type: ShadingType.CLEAR }
    }))
  });
  const dataRows = rows.map((row, i) => new TableRow({
    children: row.map((cellText, c) => mkCell(cellText, c, {
      shading: i % 2 === 1 ? { fill: THEME.zebra, type: ShadingType.CLEAR } : undefined
    }))
  }));
  return new Table({
    columnWidths: Array(colCount).fill(colWidth),
    margins: { top: 80, bottom: 80, left: 140, right: 140 },
    rows: [headerRow, ...dataRows]
  });
}

/* ---------- 封面 ---------- */
function cover() {
  return [
    new Paragraph({ spacing: { before: 2400 }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: '星期衣精致洗衣', font: FONT.heading, size: FS.coverTitle, bold: true, color: THEME.primary })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
      children: [new TextRun({ text: '衣物照片系统 · 操作手册', font: FONT.heading, size: FS.coverSub, bold: true, color: THEME.accent })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: '当前版本：v0.1.0', font: FONT.body, size: FS.body, color: NEUTRAL.textSecondary })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 2000 },
      children: [new TextRun({ text: '文档日期：2026 年 9 月', font: FONT.body, size: FS.body, color: NEUTRAL.textSecondary })]
    }),
    new Paragraph({ children: [new PageBreak()] })
  ];
}

/* ---------- 正文 ---------- */
const children = [];
children.push(...cover());

/* 一、系统概述 */
children.push(h1('一、系统概述'));
children.push(body(
  '星期衣精致洗衣衣物照片系统是一款面向洗衣店的桌面应用，用于在收衣环节对衣物进行拍照存档，' +
  '以衣物条形码为索引建立档案，取衣时可随时调阅核对，避免衣物混淆与纠纷。'
));
children.push(body(
  '系统分为客户端与管理端：店员使用客户端拍照与查询；管理员使用管理端管理账号权限、' +
  '审计操作日志、查看与清理全部存档数据。系统支持多台电脑联网使用，数据集中在服务端电脑。'
));
children.push(h2('1.1 功能一览'));
children.push(makeTable(
  ['模块', '主要功能'],
  [
    ['账号登录', '账号密码登录、修改密码；登录页可随时调整客户端连接的服务器地址'],
    ['衣物拍照', '摄像头最大分辨率拍摄；扫码后自动进入拍摄状态；空格连拍、回车批量保存'],
    ['记录查询', '按条形码、关键词、日期范围查询；照片缩略图展示；勾选批量删除'],
    ['用户与权限', '新增、编辑、停用、删除账号；分配拍照与查询权限；重置密码'],
    ['操作日志', '所有账号的登录与操作记录，支持多维度筛选查询'],
    ['数据查看', '查看与删除全部账号的存档数据'],
    ['系统设置', '服务端口、连接码、照片保存路径、版本与更新检查']
  ],
  [AlignmentType.CENTER, AlignmentType.LEFT]
));

/* 二、安装与启动 */
children.push(h1('二、安装与启动'));
children.push(h2('2.1 环境要求'));
children.push(bullet('操作系统：Windows 10 / 11（64 位）'));
children.push(bullet('无需安装任何其他软件：运行环境已内置在安装包中'));
children.push(bullet('硬件：摄像头（拍照用）、扫码枪（可选，即插即用）'));
children.push(h2('2.2 一键安装（三步完成）'));
children.push(steps('steps-install', '把安装包「xingqiyi-laundry-photo-setup-版本号.exe」复制到目标电脑。'));
children.push(steps('steps-install', '双击安装包。如出现「已保护你的电脑」提示（因软件未做数字签名），点「更多信息」再点「仍要运行」，之后自动完成安装，全程无需任何选择。'));
children.push(steps('steps-install', '安装完成后自动启动程序，桌面与开始菜单会出现「星期衣衣物照片系统」快捷方式。'));
children.push(h2('2.3 日常启动'));
children.push(body('以后每次使用，双击桌面快捷方式即可。多台电脑使用时，为每台电脑分别双击安装一次；建议为每台使用电脑固定一台扫码枪与摄像头。'));
children.push(h2('2.4 卸载'));
children.push(body('在 Windows 设置「应用 → 安装的应用」中找到本软件卸载即可；卸载不影响已保存的账号与照片数据，重装后数据仍在。'));

/* 三、首次启动设置 */
children.push(h1('三、首次启动：选择运行模式'));
children.push(body(
  '首次启动会进入运行模式设置页，请根据这台电脑的角色二选一。设置保存后需重启程序生效；' +
  '之后如需切换，可在登录页底部的服务器设置或管理端系统设置中调整。'
));
children.push(h2('3.1 作为服务端（推荐第一台电脑选择）'));
children.push(body(
  '本电脑作为数据中枢：所有账号、存档记录、操作日志与照片都保存在这台电脑上，' +
  '并自动开启局域网服务（默认端口 17521）供其他电脑接入。保存后界面会显示服务端口、连接码与本机局域网 IP，请抄录备用。'
));
children.push(h2('3.2 作为客户端'));
children.push(body(
  '本电脑作为工作站，连接已有的服务端。填写管理员提供的服务器地址（形如 http://192.168.1.10:17521）' +
  '与连接码，先点测试连接，通过后保存即可。'
));
children.push(tip('登录页底部也有「服务器设置」入口，客户端电脑更换服务器地址时无需重装，直接在此修改并保存即可生效。'));

/* 四、登录 */
children.push(h1('四、登录与账号'));
children.push(h2('4.1 默认账号'));
children.push(makeTable(
  ['账号', '初始密码', '角色'],
  [['admin', 'admin123', '管理员（管理端）']],
  [AlignmentType.CENTER, AlignmentType.CENTER, AlignmentType.CENTER]
));
children.push(body('首次登录后请立即在设置页修改密码，并通过管理端为每位店员创建独立账号。'));
children.push(h2('4.2 登录页功能'));
children.push(bullet('输入账号密码登录；管理员进入管理端，店员进入客户端。'));
children.push(bullet('底部「服务器设置」：查看当前运行模式；客户端可随时修改服务器地址与连接码，支持先测试连接再保存。'));
children.push(h2('4.3 修改密码'));
children.push(body('客户端账号在「设置」页、管理员在侧边栏进入相应页面均可查看账号信息；修改密码需输入原密码，新密码至少 6 位。'));

/* 五、客户端操作 */
children.push(h1('五、客户端操作（店员）'));
children.push(h2('5.1 首页'));
children.push(body(
  '首页展示本人的存档总数、今日新增数量与最近六条存档，并提供「衣物拍照」「记录查询」两个快捷入口。' +
  '点击任意存档卡片可查看详情。'
));
children.push(h2('5.2 衣物拍照（核心流程）'));
children.push(body('标准操作流程共三步：扫码、拍照、保存。'));
children.push(steps('steps-capture', '扫码：进入拍照页后光标自动停在条形码输入框，用扫码枪扫衣物条码（或手动输入后按回车），系统自动确认条码并进入拍摄状态，无需任何点击。'));
children.push(steps('steps-capture', '拍照：按空格键拍摄一张，可连续按空格拍多张（如正面、背面、瑕疵细节），右侧实时显示缩略图队列，每张标注序号，可单独移除或清空。'));
children.push(steps('steps-capture', '保存：按回车键或点击「保存全部」，队列中所有照片一次性存档，自动接续该条码已有的编号（第 1 张、第 2 张…），保存后条码框自动清空并重新聚焦，直接扫下一件。'));
children.push(h3('拍照页要点'));
children.push(bullet('照片按摄像头最大分辨率拍摄，取景框旁实时显示当前分辨率；已启用连续自动对焦与近距对焦，减少虚焦。'));
children.push(bullet('备注栏可填写已有瑕疵、特殊洗护要求等信息（可选），同一批次照片共用该备注。'));
children.push(bullet('扫码枪相当于键盘输入：请确保光标在条形码输入框内再扫码。'));
children.push(h3('快捷键'));
children.push(makeTable(
  ['按键', '作用', '备注'],
  [
    ['空格', '拍摄一张照片', '可连续按，拍多张'],
    ['回车', '保存全部 / 确认条码', '输入框内为确认条码，输入框外为保存']
  ],
  [AlignmentType.CENTER, AlignmentType.LEFT, AlignmentType.LEFT]
));
children.push(h2('5.3 记录查询'));
children.push(body(
  '支持按条形码精确查询，也可按关键词（条码、备注模糊匹配）与日期范围组合筛选。' +
  '每张卡片显示条码、编号、拍摄时间；点击卡片查看详情大图。'
));
children.push(body(
  '批量删除：勾选卡片左上角的勾选框（或点「全选本页」），再点「批量删除」。' +
  '删除前会弹出确认框，删除后照片文件一并删除且不可恢复，请谨慎操作。店员只能删除本人存档的记录。'
));
children.push(h2('5.4 设置'));
children.push(body('展示本账号的角色、权限开通情况、创建时间与最近登录时间，并可修改登录密码。'));

/* 六、管理端操作 */
children.push(h1('六、管理端操作（管理员）'));
children.push(h2('6.1 数据总览'));
children.push(body('展示账号总数、启用中账号数、存档照片总数、今日新增，以及最近存档与最近操作日志，便于快速掌握门店情况。'));
children.push(h2('6.2 用户与权限'));
children.push(bullet('新增账号：用户名（3-20 位字母数字下划线）、姓名、角色、初始密码（至少 6 位）。'));
children.push(bullet('权限开关：为客户端账号分别开通或关闭「衣物拍照」「记录查询」两项功能。'));
children.push(bullet('停用 / 启用：停用后该账号立即无法登录，已登录的会话也会即时失效。'));
children.push(bullet('重置密码：编辑账号时填写新密码即可重置；删除账号前请确认其存档已交接。'));
children.push(h2('6.3 操作日志'));
children.push(body(
  '记录所有账号的登录（含失败）与关键操作，可按账号、操作类型、关键词、日期范围筛选。' +
  '发生纠纷时可据此追溯操作人与时间。'
));
children.push(h2('6.4 数据查看'));
children.push(body(
  '查看全部账号登记的衣物存档，可按所属账号、条形码、关键词、日期筛选；' +
  '支持查看详情与批量删除（管理员可删除任意账号的记录）。'
));
children.push(h2('6.5 系统设置'));
children.push(h3('服务信息'));
children.push(bullet('查看运行模式、本机局域网 IP、连接码；客户端模式可查看已配置的服务器地址。'));
children.push(bullet('修改服务端口后自动重启服务；重置连接码后所有客户端需使用新码重新配置。'));
children.push(h3('照片保存路径'));
children.push(body(
  '可修改照片保存目录，保存时自动把现有照片迁移到新目录（含条码子文件夹）；' +
  '若目标目录已存在同名文件会中止迁移并提示，避免覆盖。'
));
children.push(h3('版本与更新'));
children.push(body(
  '展示当前版本号与检查结果，可手动点击「检查更新」；服务端管理员可一键打开更新文件夹。' +
  '详见第九章「软件更新」。'
));

/* 七、多电脑联网 */
children.push(h1('七、多电脑联网使用'));
children.push(body('系统采用「服务端 + 客户端」架构，数据全部集中在服务端，各客户端实时读写，无需手工同步文件。'));
children.push(h2('7.1 同一局域网'));
children.push(steps('steps-lan', '选定一台电脑作为服务端（建议固定不移动的电脑），保持程序运行。'));
children.push(steps('steps-lan', '在服务端管理端「系统设置」页抄录本机局域网 IP、端口与连接码。'));
children.push(steps('steps-lan', '其他电脑安装本程序，首次启动选择「作为客户端」，填入上述地址与连接码，测试通过后保存。'));
children.push(steps('steps-lan', '若 Windows 防火墙提示，请允许程序通过专用网络。'));
children.push(h2('7.2 跨城市 / 异地使用'));
children.push(body('数据集中在服务端的特性使异地使用无需同步文件，只需打通网络，推荐两种方式：'));
children.push(bullet('异地组网（推荐）：在服务端与每台客户端安装虚拟局域网工具（如 Tailscale、ZeroTier），各设备获得同一虚拟网段的固定 IP，客户端填写虚拟 IP 即可，安全性好、配置简单。'));
children.push(bullet('内网穿透：使用花生壳、frp 等工具把服务端端口映射到公网地址，客户端填写映射后的地址。注意连接码务必保密，映射端口相当于把服务暴露在公网。'));
children.push(tip('连接码是访问凭证，请勿泄露；如怀疑泄露，可在管理端「系统设置」中重置连接码。'));

/* 八、数据存储 */
children.push(h1('八、数据存储与备份'));
children.push(h2('8.1 存储位置'));
children.push(body('所有数据保存在服务端电脑的当前用户数据目录下：'));
children.push(makeTable(
  ['位置', '内容'],
  [
    ['data\\config.json', '运行模式、端口、连接码、照片路径等配置'],
    ['data\\users.json', '账号数据'],
    ['data\\records.json', '存档记录（条形码索引）'],
    ['data\\logs.json', '操作日志'],
    ['photos\\', '衣物照片（可在系统设置中改到任意目录）'],
    ['updates\\', '服务端更新文件夹（存放新版本安装包）']
  ],
  [AlignmentType.LEFT, AlignmentType.LEFT]
));
children.push(body(
  '完整路径形如 %APPDATA%\\星期衣精致洗衣衣物照片系统\\，可在文件资源管理器地址栏粘贴 %APPDATA% 快速定位。'
));
children.push(h2('8.2 照片命名规则'));
children.push(body(
  '照片按条形码建立子文件夹，文件名为拍摄时间（精确到分钟），例如：'
));
children.push(body('photos\\XQ20260902001\\202609021545.jpg', { noIndent: true }));
children.push(body('同一分钟内拍摄的多张自动追加序号（202609021545-2.jpg），不会相互覆盖。该结构便于直接浏览与备份照片文件。'));
children.push(h2('8.3 备份建议'));
children.push(bullet('定期整体备份照片目录与 data 目录（可压缩后存入移动硬盘或网盘）。'));
children.push(bullet('照片目录较大时，可先通过「系统设置」把照片保存路径改到独立磁盘，再针对该磁盘做备份。'));
children.push(bullet('程序卸载或删除不会影响已保存的数据；重装后数据仍在原位置。'));

/* 九、软件更新 */
children.push(h1('九、软件更新'));
children.push(h2('9.1 版本号'));
children.push(body('当前版本为 v0.1.0，版本号显示在侧边栏底部与管理端「系统设置 → 版本与更新」中。'));
children.push(h2('9.2 更新检查机制'));
children.push(body('系统通过服务端的更新文件夹分发新版本，流程如下：'));
children.push(steps('steps-update', '管理员把带版本号的新安装包（如 xingqiyi-0.2.0.zip）放入服务端更新文件夹：可在管理端「系统设置」点「打开服务端更新文件夹」直接打开。'));
children.push(steps('steps-update', '每台电脑（服务端与客户端）每次启动时自动扫描更新文件夹中的最新版本；客户端节点会向服务器查询。'));
children.push(steps('steps-update', '发现比当前版本更高的安装包时，界面顶部弹出更新提示条，显示新版本号与安装包文件名。'));
children.push(steps('steps-update', '各电脑按提示获取新安装包、解压覆盖安装即可；更新后版本号同步更新。'));
children.push(tip('更新文件夹中没有文件、或版本号不高于当前版本时不会提示；文件名不含版本号的文件会被忽略。'));

/* 十、常见问题 */
children.push(h1('十、常见问题'));
children.push(makeTable(
  ['问题', '解决方法'],
  [
    ['摄像头打不开', '确认摄像头已连接且未被其他程序占用，点拍照页的「重试」；检查系统隐私设置是否允许桌面应用使用相机'],
    ['拍出的照片虚焦', '系统已启用连续自动对焦与近距对焦；老旧摄像头不支持时，拍摄前稍等 1-2 秒待对焦完成，或适当增加拍摄距离'],
    ['扫码枪扫入没反应', '扫码枪相当于键盘，请确认光标在条形码输入框内（进入拍照页会自动聚焦）'],
    ['客户端连不上服务器', '确认服务端程序正在运行、防火墙放行端口、地址与连接码正确；先用「测试连接」排查'],
    ['忘记账号密码', '管理员在「用户与权限」中为该账号重置密码；管理员本人密码忘记时需删除数据目录中的 users.json 重新初始化（会清空账号）'],
    ['更换了服务器电脑', '客户端在登录页底部「服务器设置」中修改为新地址与连接码即可'],
    ['提示发现新版本', '按第九章流程获取新安装包覆盖安装']
  ],
  [AlignmentType.LEFT, AlignmentType.LEFT]
));

/* AI 标识 */
children.push(new Paragraph({ spacing: { before: 400 }, children: [] }));
children.push(new Paragraph({
  alignment: AlignmentType.RIGHT,
  children: [new TextRun({ text: '内容由 AI 生成', font: FONT.body, size: 12, color: NEUTRAL.textMuted })]
}));

/* ---------- 文档组装 ---------- */
const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: FONT.body, size: FS.body, color: NEUTRAL.text },
        paragraph: { alignment: AlignmentType.LEFT }
      }
    },
    paragraphStyles: [
      {
        id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: FS.h1, bold: true, font: FONT.heading, color: THEME.primary },
        paragraph: { spacing: SPACING.h1, outlineLevel: 0 }
      },
      {
        id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: FS.h2, bold: true, font: FONT.heading, color: THEME.accent },
        paragraph: { spacing: SPACING.h2, outlineLevel: 1 }
      },
      {
        id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: FS.h3, bold: true, font: FONT.heading, color: NEUTRAL.text },
        paragraph: { spacing: SPACING.h3, outlineLevel: 2 }
      }
    ]
  },
  numbering: {
    config: [
      {
        reference: 'bullet-list',
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } }
        }]
      },
      {
        reference: 'steps-install',
        levels: [{
          level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } }
        }]
      },
      {
        reference: 'steps-capture',
        levels: [{
          level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } }
        }]
      },
      {
        reference: 'steps-lan',
        levels: [{
          level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } }
        }]
      },
      {
        reference: 'steps-update',
        levels: [{
          level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } }
        }]
      }
    ]
  },
  sections: [{
    properties: {
      page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } }
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: '星期衣精致洗衣衣物照片系统 · 操作手册', font: FONT.body, size: FS.footnote, color: NEUTRAL.textMuted })]
        })]
      })
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: '第 ', font: FONT.body, size: FS.footnote, color: NEUTRAL.textMuted }),
            new TextRun({ children: [PageNumber.CURRENT], font: FONT.body, size: FS.footnote, color: NEUTRAL.textMuted }),
            new TextRun({ text: ' 页，共 ', font: FONT.body, size: FS.footnote, color: NEUTRAL.textMuted }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT.body, size: FS.footnote, color: NEUTRAL.textMuted }),
            new TextRun({ text: ' 页', font: FONT.body, size: FS.footnote, color: NEUTRAL.textMuted })
          ]
        })]
      })
    },
    children: children
  }]
});

const outputPath = path.join(__dirname, '..', '星期衣精致洗衣衣物照片系统-操作手册-v0.1.0.docx');
Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync(outputPath, buffer);
  console.log('文档已生成：' + outputPath);
}).catch((e) => {
  console.error('生成失败：' + (e.message || e));
  process.exit(1);
});
