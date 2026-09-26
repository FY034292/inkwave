#!/bin/sh
# Build dist/ and publish it to Cloudflare Pages (project "inkwave"). Needs a one-time `npx wrangler login`.
# usage: tools/release-pages.sh
set -e
cd "$(dirname "$0")/.."
python3 tools/build-dist.py
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/inkwave-pages.XXXXXX")
# Pages serves everything in the folder: leave out the Vercel link files
rsync -a --exclude '.vercel' --exclude 'vercel.json' dist/ "$STAGE/"
# fresh modules on every visit (revalidate; unchanged files come back as cheap 304s)
printf '/*\n  Cache-Control: public, max-age=0, must-revalidate\n' > "$STAGE/_headers"
# run from the staging folder so no repo-level wrangler config gets picked up
cd "$STAGE"
# first deploy only: create the project (fails harmlessly once it exists)
npx --yes wrangler@4 pages project create inkwave --production-branch main 2>&1 | tail -2 || true
npx --yes wrangler@4 pages deploy . --project-name inkwave --branch main --commit-dirty=true
