# Stock monitor with a real headless Chromium (MODE=browser).
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /opt/pw
RUN npm init -y >/dev/null && npm install --omit=dev playwright-core@1.63.0 && npm cache clean --force
ENV PLAYWRIGHT_CORE=/opt/pw/node_modules/playwright-core \
    HOME=/data
WORKDIR /app
CMD ["node", "monitor/monitor.js"]
