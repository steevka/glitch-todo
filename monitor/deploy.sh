#!/usr/bin/env bash
# Deploys the stock monitor to deflab (run from agent-lab; needs `ssh unraid`).
set -euo pipefail
cd "$(dirname "$0")/.."
APP=/mnt/user/appdata/gpu-monitor
PROJ=/boot/config/plugins/compose.manager/projects/gpu-monitor
ssh unraid "mkdir -p $APP/app/monitor $APP/data $PROJ && touch $APP/monitor.env && chown -R 99:100 $APP/data && chmod 600 $APP/monitor.env"
tar -cf - amazon-autobuy.user.js monitor/aod.js monitor/monitor.js monitor/page.html monitor/asins.json \
  | ssh unraid "tar -xf - -C $APP/app"
scp -q monitor/docker-compose.yml unraid:$PROJ/docker-compose.yml
ssh unraid "echo gpu-monitor > $PROJ/name && cd $PROJ && START_DELAY_MIN=${START_DELAY_MIN:-0} docker compose -p gpu-monitor up -d --force-recreate"
