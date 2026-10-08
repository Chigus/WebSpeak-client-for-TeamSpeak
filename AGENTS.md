# Repository and NAS maintenance

Read `CLAUDE.md` for the application architecture, voice protocol and verification
requirements. The following requirements apply to this user's maintained fork.

- Make all application, test, build and deployment-script changes in a real Git
  checkout. Preserve existing work and commit the reviewed changes before building
  a release. Do not deploy a loose copy of edited files or an uncommitted overlay.
- `origin` is the user's fork; `upstream` is the original project. Read the actual
  remotes instead of hard-coding a GitHub account. Future changes belong in the
  fork's maintained branch (currently `nas/macau`).
- Preserve the NAS binaural/stereo feature introduced in
  `24304f2d8ec4ecaa2962042dcd7b39a4bbab6851`: independent left/right PCM, Opus Music
  codec 5 at 192 kbps with two forced channels, codec-aware browser playback and
  the capture/playback regression tests. Ordinary mono voice must keep working.
- This NAS deployment uses WSS voice; the optional WebRTC voice mixer remains
  disabled because it is mono. Never describe duplicated mono as true stereo.
- Fetching upstream does not authorize overwriting the fork. Integrate upstream
  changes on a candidate branch, resolve conflicts, run `npm run verify` and check
  stereo behavior before advancing the maintained branch. Never automatically
  reset it to upstream, discard working changes or force-push over custom history.
- Build and deploy from the same explicit, clean commit. The Docker build must run
  `npm run verify` before pruning development dependencies. Build native modules
  on Linux; do not deploy Windows `node_modules`.
- Keep the exact deployed AGPL corresponding-source archive available at
  `/source/webspeak-stereo-source.tar.gz`, including this fork's changes, tests,
  lockfiles, license and build/deployment scripts.
- The NAS app root is `/share/CACHEDEV1_DATA/DockerData/webspeak`; the checkout is
  its `repo/` child. Keep `data/`, `tls/`, `tls-sync/`, `config/`, `docker-config/`,
  release artifacts and real Compose configuration outside that checkout. Never
  commit passwords, access tokens, private keys, registry credentials or live data.
- Preserve the existing HTTPS endpoint and runtime configuration. Code releases
  replace only the `webspeak` service, retain the previous image/configuration and
  verify health with rollback on failure. Do not restart native TeamSpeak or the
  HTTPS proxy as part of a normal application update.
- HTTP health alone does not prove voice. Record synthetic codec checks separately
  from actual TeamSpeak, browser WebCodecs and physical microphone validation.

See `docs/NAS_GIT_DEPLOYMENT.zh-CN.md` and `scripts/nas/` for the release workflow.
