// Roadie's own settings live in ~/roadie/config.json, never inside a site's repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function roadieHome() {
  return process.env.ROADIE_HOME || path.join(os.homedir(), 'roadie');
}

export const SETTING_KEYS = ['start', 'test', 'install', 'port', 'stagingUrl', 'productionUrl', 'healthPath'];

// Keep only known keys, as trimmed strings (port as a number or null).
export function cleanSettings(input = {}) {
  const out = {};
  for (const key of SETTING_KEYS) {
    if (key === 'port') {
      const n = Number(input.port);
      out.port = Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
    } else {
      out[key] = typeof input[key] === 'string' ? input[key].trim() : '';
    }
  }
  out.stagingUrl = out.stagingUrl.replace(/\/+$/, '');
  out.productionUrl = out.productionUrl.replace(/\/+$/, '');
  if (out.healthPath && !out.healthPath.startsWith('/')) out.healthPath = '/' + out.healthPath;
  return out;
}

export function createConfig(home = roadieHome()) {
  const file = path.join(home, 'config.json');

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || typeof data !== 'object') throw new Error('not an object');
      data.sites = data.sites && typeof data.sites === 'object' ? data.sites : {};
      return data;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Never silently overwrite a config we could not read.
        const parked = `${file}.unreadable-${Date.now()}`;
        try { fs.renameSync(file, parked); } catch { /* nothing to park */ }
      }
      return { sites: {} };
    }
  }

  function save(data) {
    fs.mkdirSync(home, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return {
    file,
    home,
    getSite(key) {
      return load().sites[key] || null;
    },
    saveSite(key, settings) {
      const data = load();
      data.sites[key] = cleanSettings(settings);
      data.lastSite = key;
      save(data);
      return data.sites[key];
    },
    lastSite() {
      return load().lastSite || null;
    },
  };
}
