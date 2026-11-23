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

export const DEFAULT_AI = {
  provider: 'anthropic',
  model: 'claude-fable-5-2',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: '',
};

export function cleanAi(input = {}) {
  const text = (v, fallback) => (typeof v === 'string' ? v.trim() : fallback);
  const ai = {
    provider: input.provider === 'ollama' ? 'ollama' : 'anthropic',
    model: text(input.model, DEFAULT_AI.model),
    ollamaUrl: text(input.ollamaUrl, DEFAULT_AI.ollamaUrl).replace(/\/+$/, '') || DEFAULT_AI.ollamaUrl,
    ollamaModel: text(input.ollamaModel, ''),
  };
  if (!/^https?:\/\//i.test(ai.ollamaUrl)) ai.ollamaUrl = DEFAULT_AI.ollamaUrl;
  return ai;
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
    // Which hosting-guide steps the person has ticked off for a site.
    getGuideDone(key) {
      const done = (load().guides || {})[key];
      return Array.isArray(done) ? done : [];
    },
    setGuideDone(key, id, done) {
      const data = load();
      data.guides = data.guides || {};
      const set = new Set(data.guides[key] || []);
      if (done) set.add(String(id)); else set.delete(String(id));
      data.guides[key] = [...set];
      save(data);
      return data.guides[key];
    },
    // Which AI to use. Keys and tokens are never stored here.
    getAi() {
      return cleanAi({ ...DEFAULT_AI, ...load().ai });
    },
    saveAi(ai) {
      const data = load();
      data.ai = cleanAi(ai);
      save(data);
      return data.ai;
    },
  };
}
