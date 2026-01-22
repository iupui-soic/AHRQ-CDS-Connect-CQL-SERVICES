'use strict';

const fs = require('fs');
const path = require('path');
const cql = require('cql-execution');
const semver = require('semver');

// Hot-reload state tracking
let librariesPath = null;
let lastLoadTime = 0;
let lastCheckTime = 0;
const CHECK_INTERVAL_MS = 1000; // Only check for changes once per second

class Libraries {
  constructor() {
    this._store = new Map();
  }

  addLibrary(json) {
    if (json && json.library && json.library.identifier && json.library.identifier.id) {
      const libId = json.library.identifier.id;
      const libVersion = json.library.identifier.version;
      if (! this._store.has(libId)) {
        this._store.set(libId, new Map());
      } else if (this._store.get(libId).has(libVersion)) {
        // Do a very simple check and issue a warning if the contents are different
        const loadedJSON = this._store.get(libId).get(libVersion);
        if (JSON.stringify(loadedJSON) !== JSON.stringify(json)) {
          console.error(`WARNING: Multiple copies of ${libId}:${libVersion} found with differences in content.  Only one will be loaded.`);
        }
      }
      this._store.get(libId).set(libVersion, json);
    }
  }

  all() {
    const libraries = [];
    Array.from(this._store.values()).forEach(vMap => Array.from(vMap.values()).forEach(lib => libraries.push(new cql.Library(lib, this))));
    return libraries;
  }

  resolve(id, version) {
    if (version == null) {
      return this.resolveLatest(id);
    }
    if (this._store.has(id) && this._store.get(id).has(version)) {
      return new cql.Library(this._store.get(id).get(version), this);
    }
    console.error(`Failed to resolve library "${id}" with version "${version}"`);
  }

  resolveLatest(id) {
    if (this._store.has(id) && this._store.get(id).size > 0) {
      let latestVersion;
      const versions = this._store.get(id).keys();
      for (const version of versions) {
        if (latestVersion == null || semver.gt(version, latestVersion)) {
          latestVersion = version;
        }
      }
      return this.resolve(id, latestVersion);
    }
    console.error(`Failed to resolve latest version of library "${id}"`);
  }
}

var repo = new Libraries();

function load(pathToFolder, isTopLevel = true) {
  if (!fs.existsSync(pathToFolder) || !fs.lstatSync(pathToFolder).isDirectory()) {
    console.error(`Failed to load local repository at: ${pathToFolder}.  Not a valid folder path.`);
    return;
  }

  // Track the top-level path and load time for hot-reload
  if (isTopLevel) {
    librariesPath = pathToFolder;
    lastLoadTime = Date.now();
  }

  for (const fileName of fs.readdirSync(pathToFolder)) {
    const file = path.join(pathToFolder, fileName);
    const stats = fs.lstatSync(file);
    if (stats.isFile() && !file.endsWith('.json')) {
      continue;
    } else if (stats.isDirectory()) {
      load(file, false);
    } else {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      repo.addLibrary(json);
    }
  }
}

function get() {
  return repo;
}

function reset() {
  repo = new Libraries();
}

/**
 * Get the latest modification time of a directory and all its contents (recursive).
 * Returns the most recent mtime in milliseconds.
 */
function getLatestModTime(dir) {
  try {
    let latest = fs.statSync(dir).mtimeMs;
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        latest = Math.max(latest, getLatestModTime(fullPath));
      } else if (entry.endsWith('.json')) {
        latest = Math.max(latest, stat.mtimeMs);
      }
    }
    return latest;
  } catch (err) {
    console.error(`Error checking modification time: ${err.message}`);
    return 0;
  }
}

/**
 * Check if libraries have changed and reload if needed.
 * Rate-limited to only check once per CHECK_INTERVAL_MS.
 */
function checkAndReloadIfNeeded() {
  if (!librariesPath) return;

  const now = Date.now();
  // Rate limit: only check once per second
  if (now - lastCheckTime < CHECK_INTERVAL_MS) {
    return;
  }
  lastCheckTime = now;

  const latestModTime = getLatestModTime(librariesPath);
  if (latestModTime > lastLoadTime) {
    console.log(`${new Date().toISOString()} Libraries changed (mod: ${new Date(latestModTime).toISOString()}), reloading...`);
    reset();
    load(librariesPath);
    const count = repo.all().length;
    console.log(`Reloaded ${count} libraries`);
    repo.all().forEach(lib => console.log(`  - ${lib.source.library.identifier.id}:${lib.source.library.identifier.version}`));
  }
}

module.exports = {load, get, reset, checkAndReloadIfNeeded};