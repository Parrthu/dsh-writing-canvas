/**
 * DOCX 格式引擎（Node 侧）。
 *
 * 分工遵循用户的定义：画布只管内容（Markdown），需要字体/字号/行距的文种
 * 由这里**一键套用预设规格**生成 DOCX，并在生成后回读校验。
 *
 * 为什么用 Python：python-docx 能精确控制中文字体（w:eastAsia）、固定行距、
 * 按字符的首行缩进这些 Word 细节，比在 JS 里拼 OOXML 可靠得多。
 *
 * 关于解释器：不硬编码路径。按 DSH_PYTHON → DSH 运行时目录 → PATH 上的
 * python3 依次探测，并且**要求能 import docx**，否则换下一个。
 *
 * @module dsh-writing-canvas/format/docx
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 本包内 Python 脚本的位置。 */
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'docx_tool.py');

/** 探测结果缓存：{ path } 或 { error }。 */
let interpreterCache = null;

/** 列出可能的 Python 解释器候选。 */
function pythonCandidates() {
  const candidates = [];
  if (typeof process.env.DSH_PYTHON === 'string' && process.env.DSH_PYTHON !== '') {
    candidates.push(process.env.DSH_PYTHON);
  }
  // DSH 自带的运行时（含 python-docx / openpyxl / python-pptx）。
  const runtimesRoot = join(homedir(), '.dsh', 'dsh-runtimes');
  if (existsSync(runtimesRoot)) {
    try {
      for (const entry of readdirSync(runtimesRoot)) {
        candidates.push(join(runtimesRoot, entry, 'dependencies', 'python', 'bin', 'python3'));
        candidates.push(join(runtimesRoot, entry, 'dependencies', 'python', 'bin', 'python'));
      }
    } catch {
      // 读不到就算了，继续用后面的候选。
    }
  }
  candidates.push('/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3');
  return candidates.filter((item) => item.includes('/') === false || existsSync(item));
}

/**
 * 找一个「装了 python-docx」的 Python。
 * @returns { path } 或 { error }
 */
export async function resolvePython() {
  if (interpreterCache !== null) return interpreterCache;
  const tried = [];
  for (const candidate of pythonCandidates()) {
    try {
      await run(candidate, ['-c', 'import docx; print(docx.__version__ if hasattr(docx, "__version__") else "ok")'], {
        timeout: 20_000,
      });
      interpreterCache = { path: candidate };
      return interpreterCache;
    } catch (error) {
      tried.push(`${candidate}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  interpreterCache = {
    error:
      '找不到可用的 Python（需要能 import docx）。已尝试：\n' +
      tried.join('\n') +
      '\n可设置环境变量 DSH_PYTHON 指向正确的解释器。',
  };
  return interpreterCache;
}

/** 重置解释器缓存（配置变更后调用）。 */
export function resetPythonCache() {
  interpreterCache = null;
}

/**
 * 生成 DOCX 并回读校验。
 *
 * @param options - 参数。
 * @param options.content - Markdown 正文。
 * @param options.spec - 格式规格。
 * @param options.specId - 规格 id。
 * @param options.title - 文档标题。
 * @param options.outPath - 输出文件绝对路径。
 * @returns Python 脚本返回的报告对象。
 */
async function runJob(options) {
  const python = await resolvePython();
  if (python.error !== undefined) {
    return { ok: false, error: 'python-unavailable', message: python.error };
  }
  if (!existsSync(SCRIPT_PATH)) {
    return { ok: false, error: 'script-missing', message: `找不到格式脚本：${SCRIPT_PATH}` };
  }

  const jobPath = `${options.outPath}.job.json`;
  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(
    jobPath,
    JSON.stringify(
      {
        mode: 'generate',
        content: options.content,
        spec: options.spec,
        specId: options.specId,
        title: options.title,
        outPath: options.outPath,
      },
      null,
      2,
    ),
    'utf8',
  );

  try {
    const { stdout } = await run(python.path, [SCRIPT_PATH, jobPath], {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const text = stdout.trim();
    const start = text.indexOf('{');
    if (start === -1) {
      return { ok: false, error: 'bad-output', message: `Python 未返回 JSON：${text.slice(0, 500)}` };
    }
    return JSON.parse(text.slice(start));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    return {
      ok: false,
      error: 'run-failed',
      message: `${detail}\n${stdout.slice(0, 1000)}`,
    };
  } finally {
    await rm(jobPath, { force: true });
  }
}

/**
 * 用规格生成一份 DOCX。
 *
 * @param options - 参数。
 * @param options.workspacePath - 会话所属工作区。
 * @param options.stateDir - 状态目录名。
 * @param options.docId - 文档标识。
 * @param options.content - Markdown 正文。
 * @param options.spec - 格式规格。
 * @param options.specId - 规格 id。
 * @param options.title - 文档标题。
 * @returns { ok, file, bytes, verification, warnings } 或 { ok:false, error, message }
 */
export async function exportDocx(options) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = String(options.title ?? options.docId ?? 'document')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .slice(0, 60);
  const outPath = join(
    options.workspacePath,
    options.stateDir,
    'exports',
    `${safeName}-${options.specId}-${stamp}.docx`,
  );

  const report = await runJob({
    content: options.content,
    spec: options.spec,
    specId: options.specId,
    title: options.title,
    outPath,
  });

  if (report.ok === false && report.error !== undefined && report.verification === undefined) {
    return report;
  }
  return {
    ...report,
    specId: options.specId,
    // 相对工作区的路径，便于界面显示与用户查找。
    relativePath: outPath.slice(options.workspacePath.length + 1),
  };
}

/**
 * 只做回读校验（不重新生成）。
 * @param options - { outPath, spec }
 * @returns 校验报告。
 */
export async function verifyDocx(options) {
  const python = await resolvePython();
  if (python.error !== undefined) return { ok: false, error: 'python-unavailable', message: python.error };
  if (!existsSync(options.outPath)) {
    return { ok: false, error: 'file-missing', message: `文件不存在：${options.outPath}` };
  }
  const jobPath = `${options.outPath}.verify.json`;
  await writeFile(jobPath, JSON.stringify({ mode: 'verify', outPath: options.outPath, spec: options.spec }), 'utf8');
  try {
    const { stdout } = await run(python.path, [SCRIPT_PATH, jobPath], { timeout: 60_000 });
    const text = stdout.trim();
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch (error) {
    return { ok: false, error: 'run-failed', message: String(error) };
  } finally {
    await rm(jobPath, { force: true });
  }
}

/** 读回导出文件（供界面下载/预览）。 */
export async function readExport(filePath) {
  return readFile(filePath);
}
