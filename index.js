import http from "node:http";

const port = Number(process.env.PORT || 3000);

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("tg-channel-relay-bot: ok");
});

server.listen(port, () => {
  console.log(`Health server listening on ${port}`);
});

import("./bot.mjs").catch((error) => {
  console.error("Failed to start relay bot:", error);
  process.exitCode = 1;
});
