#!/bin/sh
# GitHub Pages 배포: public/ + game/ 을 gh-pages 브랜치로 발행
# 사용법: npm run deploy:pages
set -e
cd "$(dirname "$0")/.."
rm -rf .pages-build
mkdir -p .pages-build
cp -R public/. .pages-build/
mkdir -p .pages-build/game
cp -R game/. .pages-build/game/
cd .pages-build
git init -q
git checkout -qb gh-pages
git add -A
git commit -qm "deploy: GitHub Pages"
git push -f https://github.com/johnny-42/splendor.git gh-pages
cd ..
rm -rf .pages-build
echo "배포 완료: https://johnny-42.github.io/splendor/"
