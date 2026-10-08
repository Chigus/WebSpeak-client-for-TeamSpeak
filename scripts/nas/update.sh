#!/bin/sh
# Advance only the fork's currently tracked branch, then run its release script.
set -eu
umask 077

APP=/share/CACHEDEV1_DATA/DockerData/webspeak
STEREO_ANCHOR=24304f2d8ec4ecaa2962042dcd7b39a4bbab6851
LOCK_HELD=0

die() { printf 'Update stopped: %s\n' "$*" >&2; exit 1; }
git_repo() { "$GIT" -C "$REPO" "$@"; }
unlock() {
  if [ "$LOCK_HELD" -eq 1 ] && [ "$(cat "$APP/.git-release-lock/pid" 2>/dev/null)" = "$$" ]; then
    rm -f "$APP/.git-release-lock/pid"
    rmdir "$APP/.git-release-lock"
    LOCK_HELD=0
  fi
}
finish() { UPDATE_CODE=$?; trap - 0 HUP INT TERM; set +e; unlock; exit "$UPDATE_CODE"; }

main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --app) [ "$#" -ge 2 ] || die 'Missing app path'; APP=$2; shift 2 ;;
      --help|-h)
        printf '%s\n' 'Usage: sh scripts/nas/update.sh [--app ABSOLUTE_APP_PATH]' 'Requires a clean branch tracking origin/<the-same-branch>. Fetches and fast-forwards only; never merges upstream automatically.'
        exit 0 ;;
      *) die 'Unknown argument' ;;
    esac
  done
  case "$APP" in /*) ;; *) die 'App path must be absolute' ;; esac
  case "$APP" in *[!A-Za-z0-9_./\ -]*) die 'Unsupported characters in app path' ;; esac
  [ -d "$APP" ] || die 'Existing app directory is required'
  APP=$(CDPATH= cd "$APP" && pwd -P) || die 'Cannot resolve app path'
  case "$APP" in *[!A-Za-z0-9_./\ -]*) die 'Resolved app path contains unsupported characters' ;; esac
  case "$APP" in /|/share|/share/CACHEDEV1_DATA) die 'App path is too broad' ;; esac
  REPO=$APP/repo
  [ -d "$REPO" ] && [ ! -L "$REPO" ] || die 'APP/repo must be a real checkout directory'
  if [ -z "${GIT:-}" ]; then
    if [ -x "$APP/tools/git" ]; then GIT=$APP/tools/git; else GIT=git; fi
  fi
  export GIT
  ROOT=$(git_repo rev-parse --show-toplevel) || die 'Cannot read Git worktree root'
  [ "$ROOT" = "$REPO" ] || die 'Unexpected Git worktree root'
  mkdir "$APP/.git-release-lock" 2>/dev/null || die 'A release/update owns the lock; inspect its PID before retrying'
  LOCK_HELD=1
  printf '%s\n' "$$" >"$APP/.git-release-lock/pid"
  STATUS=$(git_repo status --porcelain --untracked-files=all) || die 'Cannot inspect working tree'
  [ -z "$STATUS" ] || die 'Working changes must be committed or preserved first'
  BRANCH=$(git_repo symbolic-ref --quiet --short HEAD) || die 'A checked-out maintained branch is required'
  git_repo check-ref-format --branch "$BRANCH" >/dev/null || die 'Invalid branch'
  TRACKING_REMOTE=$(git_repo config --get "branch.$BRANCH.remote") || die 'Configure this branch to track the fork first'
  TRACKING_BRANCH=$(git_repo config --get "branch.$BRANCH.merge") || die 'Configure branch tracking first'
  [ "$TRACKING_REMOTE" = origin ] && [ "$TRACKING_BRANCH" = "refs/heads/$BRANCH" ] || die 'The maintained branch must track origin with the same branch name'
  PREVIOUS_HEAD=$(git_repo rev-parse --verify HEAD) || die 'Cannot read current commit'
  git_repo merge-base --is-ancestor "$STEREO_ANCHOR" "$PREVIOUS_HEAD" || die 'Current branch does not retain the stereo history'
  # Do not echo origin URLs; authentication belongs in the Git helper, not scripts.
  git_repo fetch --quiet --no-tags origin "refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  CANDIDATE=$(git_repo rev-parse --verify "refs/remotes/origin/$BRANCH^{commit}") || die 'Cannot resolve fetched commit'
  git_repo merge-base --is-ancestor "$PREVIOUS_HEAD" "$CANDIDATE" || die 'Local and fork histories diverged; resolve on a candidate branch'
  git_repo merge-base --is-ancestor "$STEREO_ANCHOR" "$CANDIDATE" || die 'Fetched history does not retain the stereo commit'
  STATUS=$(git_repo status --porcelain --untracked-files=all) || die 'Cannot recheck working tree'
  [ -z "$STATUS" ] || die 'Working changes appeared during fetch'
  CURRENT_HEAD=$(git_repo rev-parse --verify HEAD) || die 'Cannot recheck current commit'
  [ "$CURRENT_HEAD" = "$PREVIOUS_HEAD" ] || die 'Checkout changed during fetch'
  git_repo merge --ff-only "$CANDIDATE"
  [ -f "$REPO/scripts/nas/release.sh" ] || die 'Fetched commit is missing the release script'
  printf 'Fork branch advanced to %s; starting its release script.\n' "$CANDIDATE"
  # Execute the newly committed script, not partially overwritten shell source.
  # Releasing the lock allows the fresh script to acquire it; all release guards
  # are checked again, so a competing operation can stop this run but not mix commits.
  unlock
  trap - 0 HUP INT TERM
  exec sh "$REPO/scripts/nas/release.sh" --app "$APP" --commit "$CANDIDATE"
}

trap finish 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
main "$@"
