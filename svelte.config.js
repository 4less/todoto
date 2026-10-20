// Static SPA build (index.html fallback), deployed to GitHub Pages.
// See: https://svelte.dev/docs/kit/single-page-apps
import adapter from "@sveltejs/adapter-static";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
    // Registered manually in +layout.svelte — only in the browser, not in the
    // Tauri shell, which serves the app from its own bundle anyway.
    serviceWorker: { register: false },
    paths: {
      base: process.env.BASE_PATH ?? "",
    },
  },
};

export default config;
