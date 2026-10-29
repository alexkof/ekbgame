#!/usr/bin/env bash
# Публикует сборку в ветку gh-pages (из неё GitHub Pages раздаёт сайт).
#
#   publish-pages.sh deploy <dist-dir> <branch>   — выложить сборку ветки
#   publish-pages.sh remove <branch>              — удалить превью удалённой ветки
#
# Ветка main публикуется в корень сайта, остальные — в preview/<slug>/.
# Список превью собирается в preview/index.html.
set -euo pipefail

MODE=$1
MAIN_BRANCH=${MAIN_BRANCH:-main}
REMOTE=${REMOTE:-origin}
WORKTREE=$(mktemp -d)

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+|-+$//g'
}

cleanup() { git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if git fetch --quiet "$REMOTE" gh-pages 2>/dev/null; then
  git worktree add --quiet -B gh-pages "$WORKTREE" "$REMOTE/gh-pages"
else
  git worktree add --quiet --orphan -b gh-pages "$WORKTREE"
fi

case "$MODE" in
  deploy)
    DIST=$(cd "$2" && pwd)
    BRANCH=$3
    if [[ "$BRANCH" == "$MAIN_BRANCH" ]]; then
      # Корень сайта целиком заменяется сборкой main, превью сохраняются.
      find "$WORKTREE" -mindepth 1 -maxdepth 1 ! -name .git ! -name preview -exec rm -rf {} +
      cp -R "$DIST"/. "$WORKTREE"/
      TARGET="/"
    else
      SLUG=$(slugify "$BRANCH")
      rm -rf "$WORKTREE/preview/$SLUG"
      mkdir -p "$WORKTREE/preview/$SLUG"
      cp -R "$DIST"/. "$WORKTREE/preview/$SLUG"/
      echo "$BRANCH" > "$WORKTREE/preview/$SLUG/.branch"
      TARGET="/preview/$SLUG/"
    fi
    MESSAGE="Deploy $BRANCH@${GITHUB_SHA:-$(git rev-parse --short HEAD)} to $TARGET"
    ;;
  remove)
    BRANCH=$2
    SLUG=$(slugify "$BRANCH")
    rm -rf "$WORKTREE/preview/$SLUG"
    MESSAGE="Remove preview of $BRANCH"
    ;;
  *)
    echo "unknown mode: $MODE" >&2
    exit 1
    ;;
esac

touch "$WORKTREE/.nojekyll"

# Страница со списком превью веток.
mkdir -p "$WORKTREE/preview"
{
  echo '<!doctype html><html lang="ru"><head><meta charset="utf-8">'
  echo '<meta name="viewport" content="width=device-width,initial-scale=1">'
  echo '<title>Превью веток</title>'
  echo '<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px}li{margin:6px 0}</style>'
  echo '</head><body><h1>Превью веток</h1><p><a href="../">Основная версия (main)</a></p><ul>'
  for dir in "$WORKTREE"/preview/*/; do
    [[ -d "$dir" ]] || continue
    slug=$(basename "$dir")
    name=$(cat "$dir/.branch" 2>/dev/null || echo "$slug")
    echo "<li><a href=\"./$slug/\">$name</a></li>"
  done
  echo '</ul></body></html>'
} > "$WORKTREE/preview/index.html"

cd "$WORKTREE"
git add -A
if git diff --cached --quiet; then
  echo "Нет изменений для публикации."
  exit 0
fi
git commit --quiet -m "$MESSAGE"
git push --quiet "$REMOTE" gh-pages
echo "$MESSAGE"
