/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Offline support: precache the app shell so todoto opens without a network.
// Data lives in IndexedDB and GitHub API calls always go to the network.

import { base, build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `todoto-${version}`;
// The app shell; `${base}/` (not index.html) is what both GitHub Pages and
// `vite preview` serve for the SPA root.
const SHELL = `${base}/`;
const ASSETS = [...build, ...files, SHELL];

sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim())
  );
});

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== sw.location.origin) return;

  // SPA: every navigation gets the app shell — network first so a new deploy
  // shows up right away, cached copy when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => (await caches.match(SHELL)) ?? Response.error())
    );
    return;
  }

  // Build output is content-hashed and static files are versioned with the
  // deploy, so the cache is authoritative for them.
  if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then((r) => r ?? fetch(req)));
  }
});
