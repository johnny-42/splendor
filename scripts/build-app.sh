#!/bin/sh
# 네이티브 앱용 웹 번들(www/) 생성: public/ + game/
# 사용법: npm run build:app
set -e
cd "$(dirname "$0")/.."
rm -rf www
mkdir -p www
cp -R public/. www/
mkdir -p www/game
cp -R game/. www/game/
echo "www/ 번들 생성 완료"
