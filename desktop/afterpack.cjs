/* afterPack 钩子：绕过杀软对刚写出 exe 的短暂文件锁。
 * electron-builder 内置的 rcedit 会在写盘后立即执行，常撞上 Defender 实时扫描
 * （"Unable to commit changes"）；这里延迟后手动执行并带指数退避重试
 * （大 exe 的实时扫描可锁住十几秒，短间隔 5 次不够）。
 * rcedit 路径为 electron-builder 缓存的 winCodeSign-2.6.0（见方案文档 §6.3）。 */
const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function afterPack(context) {
  const exe = path.join(context.appOutDir, 'PhotoLab.exe')
  const rcedit = path.join(process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'),
    'electron-builder', 'Cache', 'winCodeSign', 'winCodeSign-2.6.0', 'rcedit-x64.exe')
  const icon = path.join(context.packager.projectDir, '..', 'build', 'icon.ico')
  const args = [
    exe,
    '--set-version-string', 'FileDescription', 'PhotoLab — 本地照片调色器（Electron 壳）',
    '--set-version-string', 'ProductName', 'PhotoLab',
    '--set-version-string', 'LegalCopyright', 'Copyright © 2026 nothing1145141',
    '--set-file-version', '1.0.0',
    '--set-product-version', '1.0.0.0',
    '--set-version-string', 'InternalName', 'PhotoLab',
    '--set-version-string', 'CompanyName', 'nothing1145141',
    '--set-icon', icon,
  ]
  await new Promise((r) => setTimeout(r, 2500))
  let delay = 1500
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      execFileSync(rcedit, args)
      console.log(`  • afterPack: rcedit OK (attempt ${attempt})`)
      return
    } catch (err) {
      console.warn(`  • afterPack: rcedit attempt ${attempt} failed: ${err.status ?? err.message}`)
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 10000)     // 指数退避：1.5s -> 3s -> 6s -> 10s
    }
  }
  throw new Error('afterPack: rcedit 全部重试失败（杀软持续锁定 PhotoLab.exe，' +
    '可将本目录加入 Defender 排除后重试）')
}
