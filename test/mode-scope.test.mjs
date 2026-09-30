/**
 * 写作提示段的作用域测试。
 *
 * 这一组测试守住的是被用户投诉过两次的边界：**写作提示只能在写作模式下出现**。
 *
 * 事故经过：写作硬约束段与写作类型段原先由宿主那一行**无条件注册**。宿主组合对每个
 * 会话都生效，于是无论用户建的是哪个模式的任务，模型都会被告知「你在本工作区中承担
 * 写作任务」「正文一律通过 writing_canvas_write 写入写作画布」。用户的原话是
 * 「安装这个插件之后，好像我所有的任务都是写作一样」。
 *
 * 现在的分工：
 *   - 宿主行（dsh-writing-canvas）：界面 / 路由 / 工具，`injectPrompt: false`，不注入提示
 *   - 写作模式预设里的 `dsh-writing-canvas/mode/writing`：注入那两段提示
 *
 * 运行：node --test test/mode-scope.test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { apply as applyModeWriting, name as modeWritingName } from '../src/mode/writing.js';
import { CONSTRAINTS_SECTION_NAME, TYPES_SECTION_NAME } from '../src/prompt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const PATCH_SOURCE = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8');
// 写作模式声明单独一个 patch 文件，由 package.json 的 dsh.bundle.patch 数组挂载
// （与官方 dsh-web-app 用 presets/*.patch.yml 声明 4 个预设同一套做法）。
const PRESET_PATCH_SOURCE = await readFile(join(ROOT, 'presets', 'writing.patch.yml'), 'utf8');
const HOST_SOURCE = await readFile(join(ROOT, 'src', 'index.js'), 'utf8');
const PKG = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

/**
 * 用最小的桩件执行 mode/writing 的 apply，收集它注册的提示段。
 * @returns 注册的 segment 数组。
 */
function collectRegisteredSections() {
  const sections = [];
  const scoped = {
    systemPrompt: {
      section(segment) {
        sections.push(segment);
        return () => {};
      },
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };
  applyModeWriting({
    inject(deps, fn) {
      assert.deepEqual(deps, ['systemPrompt'], 'mode/writing 只依赖 systemPrompt');
      fn(scoped);
    },
  });
  return sections;
}

test('mode/writing 注册且只注册那两段写作提示', () => {
  assert.equal(modeWritingName, 'writing-canvas-mode-writing');
  const sections = collectRegisteredSections();
  assert.equal(sections.length, 2, '应当正好注册两段：硬约束 + 写作类型');
  const names = sections.map((s) => s.name);
  assert.deepEqual(names, [CONSTRAINTS_SECTION_NAME, TYPES_SECTION_NAME]);
  for (const section of sections) {
    assert.ok(typeof section.text === 'string' && section.text.trim() !== '', '段落正文不得为空');
    assert.equal(typeof section.order, 'number', '段落必须有 order');
  }
});

test('mode/writing 的段落顺序紧挨着（约束在前，类型在后）', () => {
  const sections = collectRegisteredSections();
  assert.equal(sections[1].order, sections[0].order + 1);
});

test('回归：宿主行默认不注入写作提示（否则所有模式都被当成写作任务）', () => {
  // 这一段是「所有任务都是写作」那个投诉的根因，必须机械守住。
  assert.match(
    HOST_SOURCE,
    /injectPrompt: false/,
    '宿主默认配置必须把 injectPrompt 关掉',
  );
  assert.match(
    HOST_SOURCE,
    /if \(config\.injectPrompt\) \{/,
    '提示段注册必须挂在 injectPrompt 开关之下',
  );
  // 关掉之后，宿主那一段不该再直接注册 systemPrompt 段落。
  const beforeGate = HOST_SOURCE.slice(0, HOST_SOURCE.indexOf('if (config.injectPrompt) {'));
  assert.ok(
    !beforeGate.includes('systemPrompt.section('),
    'injectPrompt 开关之前不得出现任何 systemPrompt 段落注册',
  );
});

test('回归：宿主 patch 里 injectPrompt 显式为 false', () => {
  const hostRow = PATCH_SOURCE.match(/- id: writing-canvas\n[\s\S]*?injectPrompt: (\w+)/);
  assert.ok(hostRow !== null, 'patch 的宿主行必须显式声明 injectPrompt');
  assert.equal(hostRow[1], 'false', '宿主行必须显式关闭 injectPrompt');
});

test('回归：预设 patch 由 package.json 的 dsh.bundle.patch 数组挂载', () => {
  // 挂载方式本身也是契约：漏挂 = 写作模式根本不上 roster。
  const patches = PKG.dsh.bundle.patch;
  assert.ok(Array.isArray(patches), 'dsh.bundle.patch 必须是数组（官方 web-app 同款）');
  assert.ok(
    patches.includes('./presets/writing.patch.yml'),
    '必须挂载 presets/writing.patch.yml，否则写作模式不会出现在模式选择器里',
  );
  assert.deepEqual(patches, ['./cordis.patch.yml', './presets/writing.patch.yml']);
  assert.ok(PKG.files.includes('presets'), 'files 必须包含 presets，否则发布后缺文件');
});

test('回归：写作模式预设挂载 mode/writing，且不在宿主行挂', () => {
  const preset = PRESET_PATCH_SOURCE.slice(PRESET_PATCH_SOURCE.indexOf('- id: preset-writing'));
  assert.match(
    preset,
    /name: 'dsh-writing-canvas\/mode\/writing'/,
    '写作模式预设必须包含 mode/writing 行，否则写作模式反而没有写作约束',
  );
  const hostRow = PATCH_SOURCE.slice(
    PATCH_SOURCE.indexOf('- id: writing-canvas'),
    PATCH_SOURCE.indexOf('- id: writing-type-creative'),
  );
  // 只认真正的插件行（带 `name:` 前缀）——注释里提到这个路径是正常的解释，不算挂载。
  assert.ok(
    !/name:\s*'dsh-writing-canvas\/mode\/writing'/.test(hostRow),
    'mode/writing 不得作为插件行挂在宿主行上——那会让所有模式都有写作提示',
  );
});

test('回归：package.json 导出 mode/writing 子路径（否则预设那一行解析不到）', () => {
  assert.equal(
    PKG.exports['./mode/writing'],
    './src/mode/writing.js',
    '必须导出 ./mode/writing，且指向真实文件',
  );
  assert.ok(PKG.files.includes('src'), 'files 必须包含 src，否则发布后该子路径缺失');
});
