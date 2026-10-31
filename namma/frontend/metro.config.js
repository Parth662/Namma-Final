const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

// Explicitly anchor projectRoot and watchFolders to only frontend
config.projectRoot = projectRoot;
config.watchFolders = [projectRoot];

// Block git, backend, python venv, uploads, storage, tools, docs, and scripts
config.resolver.blockList = [
  /.*[\/\\]\.git[\/\\].*/,
  /.*[\/\\]backend[\/\\].*/,
  /.*[\/\\]python-service[\/\\].*/,
  /.*[\/\\]venv.*[\/\\].*/,
  /.*[\/\\]storage[\/\\].*/,
  /.*[\/\\]uploads[\/\\].*/,
  /.*[\/\\]outputs[\/\\].*/,
  /.*[\/\\]tools[\/\\].*/,
  /.*[\/\\]docs[\/\\].*/,
  /.*[\/\\]scripts[\/\\].*/,
];

module.exports = config;
