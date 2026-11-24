// Monorepo: Metro must see packages/shared (TypeScript source) and the root node_modules.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const root = path.resolve(__dirname, '..');
const config = getDefaultConfig(__dirname);
config.watchFolders = [root];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules'), path.resolve(root, 'node_modules')];
config.resolver.unstable_enablePackageExports = true;
// Prefer React Native and browser builds (supabase realtime would otherwise pull the Node 'ws' package).
config.resolver.unstable_conditionNames = ['react-native', 'browser', 'require', 'import', 'default'];
module.exports = config;
