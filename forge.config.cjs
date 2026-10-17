const path = require('node:path');
const { version } = require('./package.json');

module.exports = {
  packagerConfig: {
    name: 'Papertrail',
    executableName: 'Papertrail',
    appBundleId: 'io.github.alovwang-sys.papertrail',
    asar: true,
    download: { checksums: require('electron/checksums.json') },
    icon: path.join(__dirname, 'desktop/assets/icon'),
    // Only runtime files may leave the repository in an installer.
    ignore: (file) => {
      const name = file.replaceAll('\\', '/');
      if (!name) return false;
      if (/(?:^|\/)\.env[^/]*(?:\/|$)/.test(name)) return true;
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) return true;
      return !/^\/(?:package\.json$|dist(?:\/|$)|desktop(?:\/|$)|server\/(?:ai|agents|codex-runtime|claude-runtime|opencode-runtime|projects|project-files|tikhub-tools)\.mjs$|server$|node_modules(?:\/|$))/.test(name);
    },
  },
  makers: [
    { name: '@electron-forge/maker-dmg', config: (arch) => ({ name: `Papertrail-${version}-macos-${arch}`, title: 'Papertrail', icon: path.join(__dirname, 'desktop/assets/icon.icns'), format: 'ULFO' }) },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-squirrel', config: {
      name: 'Papertrail',
      setupExe: `Papertrail-${version}-windows-x64-setup.exe`,
      setupIcon: path.join(__dirname, 'desktop/assets/icon.ico'),
      noMsi: true,
    } },
  ],
};
