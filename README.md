# todoto

Todos, notes and whiteboards in the browser, synced to a GitHub repository.

Available as a native desktop/Android app (a thin Tauri shell) and as a web
app on GitHub Pages. Both run the same code: data lives in IndexedDB, works
offline, and syncs to the GitHub repo configured in Settings.

## Development

```sh
npm install
just dev      # desktop app with hot reload
just install  # build + install the .deb
just apk      # Android debug APK
just dev-web  # browser only, http://localhost:1420
just check    # type-check
```

Pushing to `main` deploys to GitHub Pages (`.github/workflows/deploy.yml`).
