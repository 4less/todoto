<script>
  import '../app.css';
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import { isTauri } from '$lib/backend/idb';

  // Offline support for the browser/PWA build. The Tauri shell bundles the app
  // itself, and its custom scheme can't host a service worker.
  onMount(() => {
    if (!isTauri() && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register(`${base}/service-worker.js`).catch(() => {});
    }
  });
</script>

<slot />
