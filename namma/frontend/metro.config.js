const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Limit watcher scope strictly to frontend directory
config.watchFolders = [__dirname];

// Block backend, storage, processing and tools from being scanned by Metro
config.resolver.blockList = [
  /.*[\/\\]backend[\/\\].*/,
  /.*[\/\\]processing[\/\\].*/,
  /.*[\/\\]storage[\/\\].*/,
  /.*[\/\\]uploads[\/\\].*/,
  /.*[\/\\]tools[\/\\].*/,
  /.*[\/\\]venv.*[\/\\].*/,
];

module.exports = config;
